import click
from beta9 import terminal
from beta9.cli.extraclick import ClickCommonGroup
from beta9.config import ConfigContext, get_settings, load_config, save_config


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
)
@click.argument(
    "name",
    nargs=1,
    required=True,
)
def configure(token: str, name: str):
    settings = get_settings()
    config_path = settings.config_path
    contexts = load_config(config_path)

    if name in contexts and contexts[name].token:
        text = f"Context '{name}' already exists. Overwrite?"
        if terminal.prompt(text=text, default="n").lower() in ["n", "no"]:
            return

    context = ConfigContext(
        token=token, gateway_host=settings.gateway_host, gateway_port=settings.gateway_port
    )

    # Save context to config
    contexts[name] = context

    save_config(contexts=contexts, path=config_path)

    terminal.success("Configured beam context 🎉!")
