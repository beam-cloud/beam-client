import os
from pathlib import Path

from beta9.cli.main import load_cli
from beta9.config import SDKSettings

settings = SDKSettings(
    name="Beam",
    api_host=os.getenv("API_HOST", "https://app.beam.cloud"),
    gateway_host=os.getenv("GATEWAY_HOST", "gateway.beam.cloud"),
    gateway_port=int(os.getenv("GATEWAY_PORT", 443)),
    config_path=Path("~/.beam/config.ini").expanduser(),
)


cli = load_cli(settings=settings)
