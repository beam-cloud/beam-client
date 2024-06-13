import json
import random
import string
import webbrowser
from http.server import HTTPServer, SimpleHTTPRequestHandler

import click
from beta9 import terminal
from beta9.config import ConfigContext, get_settings, load_config, save_config


@click.group()
def common(**_):
    pass


@common.command(
    name="login",
    help="""Login from dashboard""",
)
@click.option("--dashboard-url", envvar="DASHBOARD_URL", default="https://platform.beam.cloud")
def login(dashboard_url: str):
    user_code = generate_user_code()
    terminal.header(f"Login from dashboard with code: {user_code}")

    webbrowser.open(f"{dashboard_url}/auth/cli-login?user_code={user_code}", new=2)

    httpd = HTTPServer(("", 3333), HandleLoginBrowserResponse)
    httpd.serve_forever()


def handle_login_request(token):
    settings = get_settings()
    config_path = settings.config_path
    contexts = load_config(config_path)
    name = "default"

    while name in contexts and contexts[name].token:
        text = f"Context '{name}' already exists. Do you want to create a new context? (y/n)"
        if terminal.prompt(text=text, default="n").lower() in ["n", "no"]:
            exit(0)

        name = terminal.prompt(text="Enter context name", default="default")

    context = ConfigContext(
        token=token,
        gateway_host=settings.gateway_host,
        gateway_port=settings.gateway_port,
    )

    # Save context to config
    contexts[name] = context

    save_config(contexts=contexts, path=config_path)

    terminal.success("Configured beam context 🎉!")


class HandleLoginBrowserResponse(SimpleHTTPRequestHandler):
    def do_POST(self):
        try:
            data = self.rfile.read(int(self.headers.get("Content-Length")))
            data = json.loads(data)
            token = data.get("token")

            if not token:
                self.send_response(400)
                self.end_headers()
                return

            handle_login_request(token)
            self.send_response(200)
            self.end_headers()
        finally:
            exit(0)

    def do_OPTIONS(self):
        # Browsers send an OPTIONS request before POST to check if the server allows the request
        # We respond with the allowed methods and origins for CORS
        self.send_response(200)
        self.end_headers()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, *args, **kwargs):
        return

    def log_error(self, *args, **kwargs):
        return


def generate_user_code():
    code_set = string.digits + string.ascii_uppercase
    code = ""

    for _ in range(6):
        code += code_set[random.randint(0, len(code_set) - 1)]

    return code
