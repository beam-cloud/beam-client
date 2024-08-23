import datetime
import json
import time
from threading import Thread
from typing import Any, Optional, Union

import click
from beta9 import terminal
from beta9.config import DEFAULT_CONTEXT_NAME, get_settings, load_config
from websockets.sync.client import ClientConnection, connect

keep_alive_enabled = True


def exit_keep_alive_thread():
    global keep_alive_enabled
    keep_alive_enabled = False


def get_setting_callback(ctx: click.Context, param: click.Parameter, value: Any):
    return getattr(get_settings(), param.name) if not value else value


@click.group()
def common(**_):
    pass


@common.command(
    name="logs",
    help="Follow logs of a stub, deployment, task, or container.",
)
@click.option(
    "--stub-id",
    type=click.STRING,
    required=False,
    help="",
)
@click.option(
    "--deployment-id",
    type=click.STRING,
    required=False,
    help="",
)
@click.option(
    "--task-id",
    type=click.STRING,
    required=False,
    help="",
)
@click.option(
    "--container-id",
    type=click.STRING,
    required=False,
    help="",
)
@click.option(
    "--lines",
    "-n",
    type=click.INT,
    required=False,
    default=250,
    help="Display the last N lines.",
)
@click.option(
    "--show-timestamp",
    type=click.BOOL,
    is_flag=True,
    required=False,
    help="Include the log's timestamp.",
)
@click.option(
    "--host",
    "realtime_host",
    type=click.STRING,
    required=False,
    callback=get_setting_callback,
    hidden=True,
)
@click.option(
    "--config-path",
    type=click.Path(),
    required=False,
    callback=get_setting_callback,
    hidden=True,
)
def logs(
    stub_id: Optional[str],
    task_id: Optional[str],
    deployment_id: Optional[str],
    container_id: Optional[str],
    lines: int,
    show_timestamp: bool,
    realtime_host: str,
    config_path: str,
):
    if bool(deployment_id) == bool(stub_id) == bool(task_id) == bool(container_id):
        raise click.BadArgumentUsage(
            "Must supply either --stub-id, --deployment-id, --task-id, or --container-id, but not all four."
        )

    contexts = load_config(config_path)
    context = contexts[DEFAULT_CONTEXT_NAME]

    websocket_params = {
        "uri": realtime_host,
        "additional_headers": {"X-BEAM-CLIENT": "CLI"},
    }

    object_id = stub_id or deployment_id or task_id or container_id
    object_type = {
        deployment_id: "BETA9_DEPLOYMENT",
        stub_id: "BETA9_STUB",
        task_id: "BETA9_TASK",
        container_id: "BETA9_CONTAINER",
    }.get(object_id, "")
    now = datetime.datetime.now(datetime.timezone.utc)

    logs_before = json.dumps(
        {
            "token": context.token,
            "streamType": "LOGS_STREAM",
            "action": "LOGS_QUERY",
            "stream": False,
            "objectType": object_type,
            "objectId": object_id,
            "size": lines,
            "endingTimestamp": now.isoformat(),
        }
    )

    logs_current = json.dumps(
        {
            "token": context.token,
            "streamType": "LOGS_STREAM",
            "action": "LOGS_ADD_STREAM",
            "stream": True,
            "objectType": object_type,
            "objectId": object_id,
            "startingTimestamp": now.isoformat(),
        }
    )

    with connect(**websocket_params) as w, terminal.progress("Streaming...") as p:
        keep_alive = Thread(target=websocket_keep_alive, args=(w,))
        keep_alive.start()

        try:
            w.send(logs_before)
            print_message(w.recv(), show_timestamp)
        except Exception as e:
            p.stop()
            exit_keep_alive_thread()
            terminal.error(str(e))

        try:
            w.send(logs_current)
            while True:
                print_message(w.recv(), show_timestamp)
        except KeyboardInterrupt:
            p.stop()
            exit_keep_alive_thread()
            terminal.print("Goodbye! 👋")
        except Exception as e:
            p.stop()
            exit_keep_alive_thread()
            terminal.error(str(e))


def print_message(msg: Union[str, bytes], show_timestamp: bool = False) -> None:
    data = json.loads(msg)
    if "logs" in data:
        hits = data["logs"]["hits"]["hits"]
    elif "error" in data:
        exit_keep_alive_thread()
        terminal.error(str(data["error"]).capitalize())
    else:
        terminal.warn(f"Unable to parse data: {data}")
        return

    hits = sorted(hits, key=lambda k: k["_source"]["@timestamp"])
    for hit in hits:
        log = hit["_source"]["msg"]
        if show_timestamp:
            log = f"[{hit['_source']['@timestamp']}] {log}"
        terminal.print(log, highlight=True, end="")


def websocket_keep_alive(conn: ClientConnection, interval: int = 60):
    """
    Keeps the websocket connection alive until `keep_alive_enabled`
    is set to `False`.

    Args:
        conn: A websocket client connection.
        interval: Number of seconds between sending pings.
    """
    while keep_alive_enabled:
        conn.ping()
        for _ in range(interval):
            if not keep_alive_enabled:
                break
            time.sleep(0.5)
