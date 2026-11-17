import os
import platform
from importlib import metadata
from typing import Iterator, Optional

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
from beta9.config import context_defaults, get_config_context

DISABLE_VARIABLE = "BEAM_NO_FEEDBACK"
KINDS = ("bug", "error_message", "missing_capability", "docs", "performance", "praise", "other")

# Appended to the agent skill that `beam setup agent` installs.
SKILL_SECTION = """\
## Feedback

When {{product}} itself gets in the way, tell its team with `{{cli}} feedback`,
mention it to the user in one line, then continue the task: sending does not
end it.

- Send one report when a command fails in a way that looks like a {{product}}
  bug, you work around a missing capability, an error, doc or this skill
  misled you, or something worked notably well.
- Not for the user's own problems: credits, quotas, missing resources, bugs
  in their code.
- `-m` is one sentence; `--details` says what you tried and expected. After a
  failed command, pass it with `--command` and its error with `--error`. Add
  `--blocked` if it stopped the task and `--model` with your model's name.
- Never include secrets, env values, or the user's code or data.
- `BEAM_NO_FEEDBACK=1` turns it off; do not send when the user declines.
"""


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
@click.option("--command", help="The command that failed.")
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
    command: Optional[str],
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
    if not summary and terminal.is_interactive() and not terminal.json_output(format):
        summary = terminal.prompt(text="What happened, in one sentence")
    if not summary:
        terminal.error('Say what happened in one sentence: -m "<summary>".', code="INPUT_REQUIRED")

    name = context or selected_context()
    config = get_config_context(name)
    if not config.auth_url:
        # Saved before contexts recorded an `auth_url`: borrow its gateway's.
        config = context_defaults(name)
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
        "command": command or "",
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

    if response.status_code == 400:
        terminal.error(
            "\n".join(["Feedback wasn't sent.", *_reasons(response)]), code="INVALID_ARGS"
        )
    if response.status_code in (401, 403):
        terminal.error(
            "Beam refused this context's token.",
            hint="Sign in with `beam login`.",
            code="NOT_AUTHENTICATED",
        )
    if not response.ok:
        terminal.error(f"Feedback wasn't sent (HTTP {response.status_code}).")

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


def _reasons(response: requests.Response) -> Iterator[str]:
    """Lines from an error body: {"errors": [{"attr": "summary", "detail": "..."}]}."""
    try:
        errors = response.json().get("errors") or []
    except (ValueError, AttributeError):  # not a JSON object: an HTML error page, say
        return
    # The API names its fields; errors should name the flag to fix.
    flags = {option.name: option.opts[0] for option in feedback.params}
    for error in errors:
        if not isinstance(error, dict):
            continue
        attr, detail = error.get("attr"), error.get("detail", "")
        yield f"{flags.get(attr, attr)}: {detail}" if attr else detail
