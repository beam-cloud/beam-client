import click

from beta9 import terminal
from beta9.cli.contexts import get_gateway_service
from beta9.clients.gateway import GatewayServiceStub


@click.group(
    name="logs",
    help="View logs",
)
@click.pass_context
def cli(ctx: click.Context):
    ctx.obj = ctx.with_resource(get_gateway_service())

@cli.command(
    name="tail",
    help="Tail logs from a container",
)
@click.pass_obj
def perf(_: GatewayServiceStub):
    terminal.warn("some logs...")