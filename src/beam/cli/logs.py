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


def get_setting_callback(ctx: click.Context, param: click.Parameter, value: Any):
    return getattr(get_settings(), param.name) if not value else value


@click.group()
def common(**_):
    pass


@common.command(
    name="logs",
    help="Follow logs of a deployment or a task.",
)
@click.option(
    "--task-id",
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
    "--lines",
    "-n",
    type=click.INT,
    required=True,
    default=10,
    help="Number of lines back to start.",
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
    task_id: Optional[str],
    deployment_id: Optional[str],
    lines: int,
    realtime_host: str,
    config_path: str,
):
    if bool(deployment_id) == bool(task_id):
        raise click.BadArgumentUsage(
            "Must supply either --deployment-id or --task-id, but not both."
        )

    contexts = load_config(config_path)
    context = contexts[DEFAULT_CONTEXT_NAME]

    websocket_params = {
        "uri": realtime_host,
        "additional_headers": {"X-BEAM-CLIENT": "CLI"},
    }

    now = datetime.datetime.now(datetime.timezone.utc)
    logs_before = json.dumps(
        {
            "token": context.token,
            "streamType": "LOGS_STREAM",
            "action": "LOGS_QUERY",
            "stream": False,
            "objectType": "BETA9_TASK" if task_id else "BETA9_DEPLOYMENT",
            "objectId": task_id or deployment_id,
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
            "objectType": "BETA9_TASK" if task_id else "BETA9_DEPLOYMENT",
            "objectId": task_id or deployment_id,
            "startingTimestamp": now.isoformat(),
        }
    )

    with connect(**websocket_params) as w, terminal.progress("Streaming..."):
        keep_alive = Thread(target=websocket_keep_alive, args=(w,))
        keep_alive.start()

        w.send(logs_before)
        print_message(w.recv())

        w.send(logs_current)
        try:
            while True:
                print_message(w.recv())
        except KeyboardInterrupt:
            global keep_alive_enabled
            keep_alive_enabled = False
            terminal.print("\rGoodbye! 👋")


def print_message(msg: Union[str, bytes]) -> None:
    data = json.loads(msg)
    try:
        hits = data["logs"]["hits"]["hits"]
    except KeyError:
        terminal.warn(f"Unable to parse message: {data}")
        return

    hits = sorted(hits, key=lambda k: k["_source"]["@timestamp"])
    for hit in hits:
        terminal.print(hit["_source"]["msg"], highlight=True, end="")


def websocket_keep_alive(conn: ClientConnection, interval: int = 30):
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
            time.sleep(1)
