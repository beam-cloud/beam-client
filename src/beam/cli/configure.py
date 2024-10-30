import click
from beta9 import terminal
from beta9.cli.extraclick import ClickCommonGroup
from beta9.config import DEFAULT_CONTEXT_NAME, ConfigContext, get_settings, load_config, save_config


def validate_token(ctx: click.Context, param: click.Parameter, value: str):
    token = value.strip()
    if not token or len(token) < 64:
        raise click.BadParameter("A valid token is required", ctx=ctx, param=param)
    return token


@click.group(cls=ClickCommonGroup)
def common(**_):
    pass


@common.command(
    name="configure",
    help="""
    Configure a beam context
    """,
    epilog="""
      Examples:

        {cli_name} configure default --token MY_TOKEN

        {cli_name} configure production --token MY_TOKEN
        \b
    """,
)
@click.option(
    "--token",
    "-n",
    type=click.STRING,
    help="The token.",
    required=True,
    callback=validate_token,
)
@click.argument(
    "name",
    nargs=1,
    type=click.STRING,
    required=False,
    default=DEFAULT_CONTEXT_NAME,
)
def configure(token: str, name: str):
    settings = get_settings()
    config_path = settings.config_path
    contexts = load_config(config_path)

    if name in contexts and contexts[name].is_valid():
        while True:
            if terminal.prompt(
                text=f"Context '{name}' already exists. Overwrite? (y/n)", default="n"
            ).lower() not in ["n", "no"]:
                break

            if terminal.prompt(
                text="Would you like to provide a different context name? (y/n)", default="n"
            ).lower() not in ["y", "yes"]:
                terminal.warn(f"No changes made to {config_path}")
                return

            new_name = terminal.prompt(text="Enter a new context name")
            if new_name in contexts:
                terminal.warn("The context you entered already exists.")
                continue

            name = new_name
            break

    context = ConfigContext(
        token=token, gateway_host=settings.gateway_host, gateway_port=settings.gateway_port
    )

    # Save context to config
    contexts[name] = context
    save_config(contexts=contexts, path=config_path)

    terminal.success(f"Added new context to {config_path}")
