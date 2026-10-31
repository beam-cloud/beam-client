"""`beam feedback` posts to the account API of the selected context."""

import json
import sys

import pytest
import requests
from beta9.config import ConfigContext
from click.testing import CliRunner

TOKEN = "t" * 64


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self.ok = status_code < 400
        self.body = body

    def json(self):
        if self.body is None:
            raise ValueError("not JSON")
        return self.body


class AccountAPI:
    """Stands in for requests.post and records what the command sent."""

    def __init__(self):
        self.calls = []
        self.response = FakeResponse(202, None)

    def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


@pytest.fixture
def main(monkeypatch, tmp_path):
    monkeypatch.setenv("BEAM_TOKEN", TOKEN)
    monkeypatch.setenv("CONFIG_PATH", str(tmp_path / "config.ini"))
    for name in ("BEAM_NO_FEEDBACK", "BETA9_JSON", "BETA9_CALLER", "BETA9_AGENT_SESSION"):
        monkeypatch.delenv(name, raising=False)
    sys.modules.pop("beam.cli.main", None)
    import beam.cli.main as module

    return module


@pytest.fixture
def api(main, monkeypatch):
    fake = AccountAPI()
    monkeypatch.setattr(requests, "post", fake)
    return fake


def feedback(*args):
    from beam.cli import feedback

    return CliRunner().invoke(feedback.common, ["feedback", *args])


def test_sends_the_report_to_the_account_api(api, monkeypatch):
    monkeypatch.setenv("BETA9_AGENT_SESSION", "run-1")

    result = feedback(
        "-m",
        "deploy ignored --port",
        "--kind",
        "bug",
        "--blocked",
        "--command",
        "beam deploy app.py:handler --port 8080",
        "--error",
        "port 8000 is not exposed",
        "--model",
        "claude-opus-4",
    )

    assert result.exit_code == 0, result.output
    assert "Feedback sent. Thanks." in result.output
    [(url, request)] = api.calls
    assert url == "https://api.beam.cloud/v2/oauth/cli/feedback"
    assert request["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert request["headers"]["x-beta9-caller"].startswith("cli/")
    assert request["headers"]["x-beta9-agent-session"] == "run-1"
    report = request["json"]
    assert report["kind"] == "bug"
    assert report["summary"] == "deploy ignored --port"
    assert report["blocked"] is True
    assert report["command"] == "beam deploy app.py:handler --port 8080"
    assert report["error_message"] == "port 8000 is not exposed"
    assert report["model"] == "claude-opus-4"
    assert report["details"] == report["suggested_improvement"] == ""
    assert "python" in report["environment"]


def test_json_output(api):
    result = feedback("-m", "deploy ignored --port", "--format", "json")

    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == {"sent": True}


def test_can_be_turned_off(api, monkeypatch):
    monkeypatch.setenv("BEAM_NO_FEEDBACK", "1")

    result = feedback("-m", "deploy ignored --port")

    assert result.exit_code == 1
    assert "Feedback is turned off: BEAM_NO_FEEDBACK is set." in result.output
    assert api.calls == []


def test_needs_a_summary_without_a_terminal(api, monkeypatch):
    monkeypatch.setenv("BETA9_JSON", "1")

    result = feedback("--kind", "bug")

    assert result.exit_code == 1
    assert json.loads(result.output)["code"] == "INPUT_REQUIRED"
    assert api.calls == []


def test_names_the_flag_to_fix(api):
    api.response = FakeResponse(
        400,
        {
            "type": "validation_error",
            "errors": [
                {
                    "code": "max_length",
                    "detail": "At most 300 characters; put the rest in details.",
                    "attr": "summary",
                },
                {"code": "invalid_choice", "detail": "Not a valid choice.", "attr": "kind"},
            ],
        },
    )

    result = feedback("-m", "x" * 301)

    assert result.exit_code == 1
    assert "--message: At most 300 characters; put the rest in details." in result.output
    assert "--kind: Not a valid choice." in result.output


@pytest.mark.parametrize(
    "response, code",
    [
        (FakeResponse(401, None), "NOT_AUTHENTICATED"),
        (FakeResponse(502, None), "ERROR"),
        (requests.ConnectionError("connection refused"), "UNAVAILABLE"),
    ],
)
def test_failures_have_codes(api, monkeypatch, response, code):
    monkeypatch.setenv("BETA9_JSON", "1")
    api.response = response

    result = feedback("-m", "deploy ignored --port")

    assert result.exit_code == 1
    assert json.loads(result.output)["code"] == code


def test_contexts_without_an_account_api_cannot_send(api, monkeypatch):
    from beam.cli import feedback as module

    monkeypatch.setattr(
        module,
        "get_config_context",
        lambda _name: ConfigContext(token=TOKEN, gateway_host="gateway.example.com"),
    )

    result = feedback("-m", "deploy ignored --port")

    assert result.exit_code == 1
    assert "no Beam account" in result.output
    assert api.calls == []


def test_is_a_beam_command(main):
    result = CliRunner().invoke(main._cli.common_group, ["feedback", "--help"])

    assert result.exit_code == 0, result.output
    assert "beam feedback -m" in result.output
    assert "BEAM_NO_FEEDBACK=1" in result.output
