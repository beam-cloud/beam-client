import os
from dataclasses import dataclass
from pathlib import Path

from beta9 import config


@dataclass
class SDKSettings(config.SDKSettings):
    realtime_host: str = os.getenv("REALTIME_HOST", "wss://rt.beam.cloud")
    internal_api_host: str = os.getenv("INTERNAL_API_HOST", "api.beam.cloud")
    internal_api_port: int = int(os.getenv("INTERNAL_API_PORT", 443))


settings = SDKSettings(
    name="Beam",
    api_host=os.getenv("API_HOST", "app.beam.cloud"),
    api_port=int(os.getenv("API_PORT", 443)),
    gateway_host=os.getenv("GATEWAY_HOST", "gateway.beam.cloud"),
    gateway_port=int(os.getenv("GATEWAY_PORT", 443)),
    config_path=Path("~/.beam/config.ini").expanduser(),
    use_defaults_in_prompt=True,
)
