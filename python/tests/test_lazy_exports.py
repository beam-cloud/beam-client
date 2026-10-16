"""The CLI must not import optional application SDK features at startup."""

import os
import subprocess
import sys


def test_cli_starts_without_pydantic():
    result = subprocess.run(
        [sys.executable, "-c", """
import importlib.abc
import sys

class MissingPydantic(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in {"pydantic", "fastapi"}:
            raise ModuleNotFoundError(f"No module named {fullname!r}", name=fullname)

sys.meta_path.insert(0, MissingPydantic())
import beam
assert "beta9.abstractions.experimental" not in sys.modules
assert "beta9.abstractions.vm" not in sys.modules
from beam.cli.main import _cli
from click.testing import CliRunner
result = CliRunner().invoke(_cli.common_group, ["vm", "list", "--help"])
assert result.exit_code == 0, result.output
assert "List VM" in result.output
assert "pydantic" not in sys.modules
assert "fastapi" not in sys.modules
"""],
        env={**os.environ, "BEAM_TOKEN": "t" * 64},
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_sdk_exports_keep_beam_client_and_public_aliases():
    from beam import Client, Image, PodInstance, VM, endpoint, function
    from beam.client.client import Client as BeamClient
    from beta9 import Image as Beta9Image
    from beta9 import VM as Beta9VM
    from beta9.abstractions.endpoint import Endpoint
    from beta9.abstractions.function import Function
    from beta9.abstractions.pod import PodInstance as Beta9PodInstance

    assert (Client, Image, PodInstance, VM, endpoint, function) == (
        BeamClient, Beta9Image, Beta9PodInstance, Beta9VM, Endpoint, Function
    )
