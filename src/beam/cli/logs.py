import click
from beta9 import terminal
from beta9.channel import ServiceClient
from beta9.cli.extraclick import ClickCommonGroup, pass_service_client


@click.group(
    name="logs",
    help="View logs.",
    cls=ClickCommonGroup,
)
@pass_service_client
def common(**_):
    pass


@common.command(
    name="tail",
    help="Tail logs from a container.",
)
@click.pass_obj
def tail(_: ServiceClient):
    terminal.warn("some logs...")
