import sys

import pytest

from beam.cli import utils


class FakeResponse:
    def raise_for_status(self):
        pass

    def json(self):
        return {"version": "0.2.202"}


@pytest.mark.parametrize("uv_tool", [False, True])
def test_check_version_upgrades_the_python_environment_running_beam(monkeypatch, capsys, tmp_path, uv_tool):
    monkeypatch.setattr(utils.requests, "get", lambda *args, **kwargs: FakeResponse())
    monkeypatch.setattr(utils.metadata, "version", lambda package: "0.2.191")
    monkeypatch.setattr(sys, "executable", "/opt/Beam Client/bin/python")
    monkeypatch.setattr(sys, "prefix", str(tmp_path))
    if uv_tool:
        (tmp_path / "uv-receipt.toml").touch()

    with pytest.raises(SystemExit) as exc_info:
        utils.check_version()

    assert exc_info.value.code == 1
    output = capsys.readouterr().out
    assert "Beam CLI update required" in output
    assert "Installed: 0.2.191" in output
    assert "Minimum:   0.2.202" in output
    assert "Python:    /opt/Beam Client/bin/python" in output
    if uv_tool:
        assert "uv tool upgrade beam-client" in output
        assert "pip install" not in output
    else:
        assert '"/opt/Beam Client/bin/python" -m pip install --upgrade beam-client' in output
    assert "beam --version" in output
