from beta9.cli.main import load_cli

from . import logs

cli = load_cli()
cli.register(logs)
