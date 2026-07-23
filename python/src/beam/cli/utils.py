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

    # Use the interpreter that is running the Beam CLI. A bare `pip` executable
    # may belong to a different Python installation, leaving this CLI unchanged.
    upgrade_command = f'"{sys.executable}" -m pip install --upgrade beam-client'

    click.echo(
        (
            f"{click.style('Beam CLI update required', fg='yellow', bold=True)}\n\n"
            f"Installed: {click.style(str(current_version), bold=True)}\n"
            f"Minimum:   {click.style(str(minimum_version), fg='yellow', bold=True)}\n"
            f"Python:    {sys.executable}\n"
            "\nUpgrade this installation (not a different `pip` on your PATH):\n"
            f"  {click.style(upgrade_command, bold=True)}\n"
            "\nThen verify:\n"
            f"  {click.style('beam --version', bold=True)}\n"
        )
    )

    sys.exit(1)
