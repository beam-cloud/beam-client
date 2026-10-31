import os
import platform
from importlib import metadata
from typing import Any, Dict, Iterator, Optional, Tuple

import click
import requests
from beta9 import terminal
from beta9.channel import caller_metadata
from beta9.cli.extraclick import (
    ClickCommonGroup,
    config_context_option,
    format_option,
    selected_context,
)
from beta9.config import get_config_context

DISABLE_VARIABLE = "BEAM_NO_FEEDBACK"
KINDS = ("bug", "error_message", "missing_capability", "docs", "performance", "praise", "other")

# The API names fields after its columns; errors should name the flag to fix.
OPTION_NAMES = {
    "summary": "--message",
    "command": "--command",
    "error_message": "--error",
    "suggested_improvement": "--suggest",
}


@click.group(cls=ClickCommonGroup)
def common(**_):
    pass


@common.command(
    name="feedback",
    help="Tell the Beam team what went wrong or what is missing.",
    epilog=f"""
      Examples:

        {{cli_name}} feedback -m "deploy ignored --port" --kind bug --blocked

        {{cli_name}} feedback -m "No way to list secrets by app" --kind missing_capability
        \b
      Coding agents: when {{cli_name}} blocks or misleads you, send one report, then carry on.
      Leave out secrets and the user's code or data.
      Set {DISABLE_VARIABLE}=1 to turn this command off.
    """,
)
@click.option(
    "--message", "-m", "summary", help="What happened, in one sentence (300 characters at most)."
)
@click.option(
    "--kind",
    type=click.Choice(KINDS),
    default="other",
    metavar="KIND",
    help=f"What the report is about: {', '.join(KINDS[:-1])} or {KINDS[-1]}.",
)
@click.option("--blocked", is_flag=True, help="It stopped the task.")
@click.option("--command", "command_line", help="The command that failed.")
@click.option("--error", "error_message", help="The error it printed.")
@click.option("--details", help="What you tried and what you expected.")
@click.option("--suggest", "suggested_improvement", help="What would have helped.")
@click.option("--model", help="The language model behind the agent, if any.")
@format_option
@config_context_option
def feedback(
    summary: Optional[str],
    kind: str,
    blocked: bool,
    command_line: Optional[str],
    error_message: Optional[str],
    details: Optional[str],
    suggested_improvement: Optional[str],
    model: Optional[str],
    format: str,
    context: Optional[str] = None,
):
    if feedback_disabled():
        terminal.error(
            f"Feedback is turned off: {DISABLE_VARIABLE} is set.", code="FEEDBACK_DISABLED"
        )
    if not summary:
        if not terminal.is_interactive() or terminal.json_output(format):
            terminal.error(
                'Say what happened in one sentence: -m "<summary>".', code="INPUT_REQUIRED"
            )
        summary = terminal.prompt(text="What happened, in one sentence?")

    config = get_config_context(context or selected_context())
    if not config.token or not config.auth_url:
        terminal.error(
            "This context has no Beam account to send feedback to.",
            hint="Sign in with `beam login`.",
            code="NOT_AUTHENTICATED",
        )

    report = {
        "kind": kind,
        "summary": summary,
        "blocked": blocked,
        "command": command_line or "",
        "error_message": error_message or "",
        "details": details or "",
        "suggested_improvement": suggested_improvement or "",
        "model": model or "",
        "environment": environment(),
    }
    try:
        response = requests.post(
            config.auth_url.rstrip("/") + "/cli/feedback",
            json=report,
            headers={"Authorization": f"Bearer {config.token}", **dict(caller_metadata())},
            timeout=30,
        )
    except requests.RequestException as e:
        terminal.error(f"Couldn't reach Beam: {e}", code="UNAVAILABLE")

    if not response.ok:
        message, code = failure(response.status_code, _json(response))
        terminal.error(message, code=code)

    if terminal.json_output(format):
        terminal.print_json({"sent": True})
    else:
        terminal.success("Feedback sent. Thanks.")


def feedback_disabled() -> bool:
    return os.getenv(DISABLE_VARIABLE, "").strip().lower() in ("1", "true", "yes")


def environment() -> str:
    try:
        client = f"; beam-client {metadata.version('beam-client')}"
    except metadata.PackageNotFoundError:
        client = ""
    return (
        f"{platform.system()} {platform.release()} {platform.machine()};"
        f" python {platform.python_version()}{client}"
    )


def failure(status: int, body: Dict[str, Any]) -> Tuple[str, str]:
    if status == 400:
        reasons = "\n".join(_reasons(body))
        return f"Feedback wasn't sent.\n{reasons}".rstrip(), "INVALID_ARGS"
    if status in (401, 403):
        return "Beam refused this context's token. Sign in with `beam login`.", "NOT_AUTHENTICATED"
    return f"Feedback wasn't sent (HTTP {status}).", "ERROR"


def _reasons(body: Dict[str, Any]) -> Iterator[str]:
    """Lines from an error body: {"errors": [{"attr": "summary", "detail": "..."}]}."""
    for error in body.get("errors") or []:
        if not isinstance(error, dict):
            continue
        attr, detail = error.get("attr"), error.get("detail", "")
        yield (
            f"{OPTION_NAMES.get(attr, '--' + attr.replace('_', '-'))}: {detail}" if attr else detail
        )


def _json(response: requests.Response) -> Dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}
