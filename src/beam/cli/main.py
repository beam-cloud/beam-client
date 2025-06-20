import os
import sys
from dataclasses import dataclass
from gettext import gettext as _
from pathlib import Path

import click
from beta9 import config
from beta9.cli.main import load_cli

from . import configure, example, login, logs, quickstart, utils


@dataclass
class SDKSettings(config.SDKSettings):
    realtime_host: str = os.getenv("REALTIME_HOST", "wss://rt.beam.cloud")


check_config = os.getenv("BEAM_TOKEN") is not None

settings = SDKSettings(
    name="Beam",
    api_host=os.getenv("API_HOST", "app.beam.cloud"),
    api_port=int(os.getenv("API_PORT", 443)),
    gateway_host=os.getenv("GATEWAY_HOST", "gateway.beam.cloud"),
    gateway_port=int(os.getenv("GATEWAY_PORT", 443)),
    config_path=Path("~/.beam/config.ini").expanduser(),
    api_token=os.getenv("BEAM_TOKEN"),
    use_defaults_in_prompt=True,
)


cli = load_cli(settings=settings, check_config=check_config)
cli.register(configure)
cli.register(quickstart)
cli.register(login)
cli.register(logs)
cli.register(example)
cli.load_version("beam-client")


_cli = cli


def cli():
    utils.check_version()

    try:
        if exit_code := _cli(standalone_mode=False):
            sys.exit(exit_code)
    except (EOFError, KeyboardInterrupt) as e:
        click.echo(file=sys.stderr)
        raise click.Abort() from e
    except click.exceptions.ClickException as e:
        e.show()
        sys.exit(e.exit_code)
    except click.exceptions.Exit as e:
        sys.exit(e.exit_code)
    except click.exceptions.Abort:
        click.echo(_("Aborted!"), file=sys.stderr)
        sys.exit(1)
