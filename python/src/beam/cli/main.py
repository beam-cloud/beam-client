import os
import sys
from gettext import gettext as _
from pathlib import Path

import click
from beta9.cli.main import load_cli
from beta9.config import ConfigContext, SDKSettings

from . import configure, example, feedback, quickstart, utils


def environment(domain: str) -> ConfigContext:
    """The Beam cluster under `domain`: gateway.<domain>, app.<domain>, api.<domain>."""
    return ConfigContext(
        gateway_host=f"gateway.{domain}",
        gateway_port=443,
        api_url=f"https://app.{domain}",
        auth_url=f"https://api.{domain}/v2/oauth",
    )


PRODUCTION = environment("beam.cloud")

# Check if the command is "configure" - skip config check for configure command
check_config = os.getenv("BEAM_TOKEN") is None and not (
    len(sys.argv) > 1 and sys.argv[1] == "configure"
)

# `beam` talks to production. `beam login --environment staging` (or `local`)
# signs in elsewhere and saves a context of that name; `--context <name>` then
# selects it on any command, `beam mcp install` included. beta9 still honours
# API_HOST, GATEWAY_HOST, GATEWAY_PORT, BEAM_AUTH_URL and BEAM_TOKEN for the
# default context (CI and containers).
settings = SDKSettings(
    name="Beam",
    api_host="app.beam.cloud",
    api_port=443,
    gateway_host=PRODUCTION.gateway_host,
    gateway_port=443,
    config_path=Path("~/.beam/config.ini").expanduser(),
    use_defaults_in_prompt=True,
    auth_url=PRODUCTION.auth_url,
    docs_url="https://docs.beam.cloud",
    environments={
        "staging": environment("stage.beam.cloud"),
        # A gateway and account API on this machine (okteto port-forwards);
        # edit [local] in ~/.beam/config.ini when yours listen elsewhere.
        "local": ConfigContext(
            gateway_host="127.0.0.1",
            gateway_port=1993,
            api_url="http://127.0.0.1:1994",
            auth_url="http://127.0.0.1:8008/v2/oauth",
        ),
    },
)


# `login` comes from beta9 (OAuth device grant against each environment's
# auth_url); the dashboard-callback login this package used to ship is retired.
cli = load_cli(settings=settings, check_config=check_config)
cli.register(configure)
cli.register(quickstart)
cli.register(example)
cli.register(feedback)
cli.load_version("beam-client")


_cli = cli


def running_command() -> str:
    """The command being run, by name only: `beam secret create`, whatever its arguments."""
    names, command = ["beam"], _cli.common_group
    for word in sys.argv[1:]:
        subcommand = getattr(command, "get_command", None)  # groups have subcommands
        command = subcommand(None, word) if subcommand else None
        if command is None:
            break
        names.append(word)
    return " ".join(names)


# Errors that beta9 prints end with the `beam feedback` command that reports
# them; `cli` below does the same for the rest. Assigned rather than passed to
# SDKSettings: a beta9 release without this setting ignores it.
settings.feedback_command = lambda: feedback.report_command(running_command())


def cli():
    if not any(arg in ("--help", "-h", "--help-all", "--version") for arg in sys.argv[1:]):
        utils.check_version()

    try:
        if exit_code := _cli(standalone_mode=False):
            sys.exit(exit_code)
    except (EOFError, KeyboardInterrupt) as e:
        click.echo(file=sys.stderr)
        raise click.Abort() from e
    except click.exceptions.ClickException as e:
        e.show()
        feedback.suggest(running_command())
        sys.exit(e.exit_code)
    except click.exceptions.Exit as e:
        sys.exit(e.exit_code)
    except click.exceptions.Abort:
        click.echo(_("Aborted!"), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # A bug in the CLI: the traceback as Python would print it, then how to report it.
        sys.excepthook(*sys.exc_info())
        feedback.suggest(running_command())
        sys.exit(1)
