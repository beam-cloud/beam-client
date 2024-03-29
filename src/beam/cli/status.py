import click

from beta9 import terminal
from beta9.cli.contexts import get_gateway_service
from beta9.clients.gateway import GatewayServiceStub


@click.group(
    name="status",
    help="Show beam.cloud status",
)
@click.pass_context
def cli(ctx: click.Context):
    ctx.obj = ctx.with_resource(get_gateway_service())

@cli.command(
    name="list",
    help="List all status",
)
@click.pass_obj
def perf(_: GatewayServiceStub):
    terminal.warn("some status")