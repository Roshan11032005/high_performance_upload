import click
from werkzeug.serving import run_simple

from webserver import create_app

cli = click.Group()
application = create_app()


@cli.command()
@click.option("--host", "-h", default="0.0.0.0", show_default=True)
@click.option("--port", "-p", default=5001, show_default=True)
@click.option("--debug", "-d", is_flag=True, help="debugger blah blah")
def runserver(host, port, debug=False):
    run_simple(
        hostname=host,
        port=port,
        application=application,
        use_debugger=debug,
        use_reloader=debug,
        threaded=True,
    )

if __name__ == "__main__":
    cli()