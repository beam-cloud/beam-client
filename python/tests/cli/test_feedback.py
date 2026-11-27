"""`beam feedback` posts to the account API of the selected context."""

import json
import sys
from types import SimpleNamespace

import click
import pytest
import requests
from beta9 import terminal
from beta9.cli.extraclick import ClickCommonGroup
from beta9.config import ConfigContext, get_settings
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
    from beam.cli import feedback

    monkeypatch.setattr(feedback, "_suggested", False)  # every test is a run of its own
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
        "--goal",
        "Put a FastAPI app online",
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
    assert report["user_request"] == "Put a FastAPI app online"
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


def test_asks_for_the_summary_in_a_terminal(api, monkeypatch):
    answers = iter(["deploy ignored --port", None])
    monkeypatch.setattr(terminal, "is_interactive", lambda: True)
    monkeypatch.setattr(terminal, "prompt", lambda text: next(answers))

    assert feedback("--kind", "bug").exit_code == 0
    unanswered = feedback("--kind", "bug")

    assert unanswered.exit_code == 1
    assert "Say what happened in one sentence" in unanswered.output
    assert [request["json"]["summary"] for _, request in api.calls] == ["deploy ignored --port"]


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


def test_contexts_saved_without_an_auth_url_use_their_gateways(api, tmp_path):
    saved = "s" * 64
    (tmp_path / "config.ini").write_text(
        f"[default]\ntoken = {saved}\ngateway_host = gateway.beam.cloud\ngateway_port = 443\n"
    )

    result = feedback("-m", "deploy ignored --port")

    assert result.exit_code == 0, result.output
    [(url, request)] = api.calls
    assert url == "https://api.beam.cloud/v2/oauth/cli/feedback"
    assert request["headers"]["Authorization"] == f"Bearer {saved}"


def test_is_a_beam_command(main):
    result = CliRunner().invoke(main._cli.common_group, ["feedback", "--help"])

    assert result.exit_code == 0, result.output
    assert "beam feedback -m" in result.output
    assert "BEAM_NO_FEEDBACK=1" in result.output


SUGGESTION = "Send feedback about this to the Beam team: "


@pytest.fixture
def beam(main, monkeypatch, capsys):
    """Runs `beam <words>` as the installed command does: its exit code and what it printed."""
    from beam.cli import utils

    monkeypatch.setattr(utils, "check_version", lambda: None)

    def run(*words):
        monkeypatch.setattr(sys, "argv", ["beam", *words])
        with pytest.raises(SystemExit) as exited:
            main.cli()
        return exited.value.code, capsys.readouterr().err

    return run


def test_a_usage_error_ends_with_the_command_that_reports_it(beam):
    code, printed = beam("secret", "create", "API_KEY", "hunter2", "--no-such-option")

    assert code == 2
    assert printed.splitlines()[-1] == (
        SUGGESTION + 'beam feedback --command "beam secret create" -m "<what happened>"'
    )


def test_a_mistyped_command_is_not_named(beam):
    code, printed = beam("deplyo", "app.py:handler")

    assert code == 2
    assert printed.splitlines()[-1] == SUGGESTION + 'beam feedback -m "<what happened>"'


def test_a_crash_ends_with_its_traceback_and_the_command_that_reports_it(main, beam):
    @click.group(cls=ClickCommonGroup)
    def common(**_):
        pass

    @common.command()
    def crash():
        raise RuntimeError("boom")

    main._cli.register(SimpleNamespace(common=common))

    code, printed = beam("crash")

    assert code == 1
    assert printed.splitlines()[-2:] == [
        "RuntimeError: boom",
        SUGGESTION + 'beam feedback --command "beam crash" -m "<what happened>"',
    ]


def test_errors_that_beta9_prints_end_with_the_same_command(main, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["beam", "deploy", "app.py:handler"])

    command = get_settings().feedback_command

    assert command() == 'beam feedback --command "beam deploy" -m "<what happened>"'
    assert command() is None  # once a run


def test_its_own_failures_do_not_suggest_it(beam):
    code, printed = beam("feedback", "--no-such-option")

    assert code == 2
    assert SUGGESTION not in printed


def test_nothing_is_suggested_when_turned_off(beam, monkeypatch):
    monkeypatch.setenv("BEAM_NO_FEEDBACK", "1")

    code, printed = beam("deploy", "--no-such-option")

    assert code == 2
    assert SUGGESTION not in printed
