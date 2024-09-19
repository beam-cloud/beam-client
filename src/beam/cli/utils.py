import os
import sys
from importlib import metadata

import click
import requests
from packaging import version

BASE_API_URL = os.getenv("BASE_API_URL", "https://api.beam.cloud")


def check_version():
    try:
        response = requests.get(f"{BASE_API_URL}/v2/api/minimum-cli-version/", timeout=1)
        response.raise_for_status()

        data = response.json()
        if "version" not in data:
            return
    except Exception:
        return

    minimum_version = version.parse(data["version"])
    current_version = version.parse(metadata.version("beam-client"))

    if current_version >= minimum_version:
        return

    click.echo(
        (
            f"{click.style('Update Required', fg='yellow', bold=True)}\n\n"
            f"Your current version: {click.style(str(current_version), bold=True)}\n"
            f"Minimum required version: {click.style(str(minimum_version), fg='yellow', bold=True)}\n"
            "\nPlease upgrade to the latest version.\n"
            f"  {click.style('pip install --upgrade beam-client', bold=True)}\n"
        )
    )

    sys.exit(1)
