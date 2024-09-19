import os
import sys
from dataclasses import dataclass
from pathlib import Path

from beta9 import config
from beta9.cli.main import load_cli

from . import configure, example, login, logs, quickstart, utils


@dataclass
class SDKSettings(config.SDKSettings):
    realtime_host: str = os.getenv("REALTIME_HOST", "wss://rt.beam.cloud")


settings = SDKSettings(
    name="Beam",
    api_host=os.getenv("API_HOST", "https://app.beam.cloud"),
    gateway_host=os.getenv("GATEWAY_HOST", "gateway.beam.cloud"),
    gateway_port=int(os.getenv("GATEWAY_PORT", 443)),
    config_path=Path("~/.beam/config.ini").expanduser(),
    use_defaults_in_prompt=True,
)


cli = load_cli(settings=settings, check_config=False)
cli.register(configure)
cli.register(quickstart)
cli.register(login)
cli.register(logs)
cli.register(example)
cli.load_version("beam-client")


_cli = cli


def cli():
    try:
        utils.check_version()

        if exit_code := _cli(standalone_mode=False):
            sys.exit(exit_code)
    except Exception:
        raise
