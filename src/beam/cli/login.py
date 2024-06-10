import json
import os
import random
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
    help="""
  Login from dashboard
  """,
)
def login():
    user_code = generate_user_code()
    print("Login from dashboard with code:", user_code)

    dashboard_url = os.getenv("BETA9_DASHBOARD_URL", "https://platform.beam.cloud")
    webbrowser.open(f"{dashboard_url}/auth/cli-login?user_code={user_code}", new=2)

    httpd = HTTPServer(("", 3333), HandleLoginBrowserResponse)
    httpd.serve_forever()


def generate_user_code():
    code_set = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    code = ""

    for _ in range(6):
        code += code_set[random.randint(0, len(code_set) - 1)]

    return code


class HandleLoginBrowserResponse(SimpleHTTPRequestHandler):
    def do_POST(self):
        try:
            data = self.rfile.read(int(self.headers.get("Content-Length")))
            data = json.loads(data)
            token = data.get("token")

            settings = get_settings()
            config_path = settings.config_path
            contexts = load_config(config_path)
            name = "default"

            while name in contexts and contexts[name].token:
                text = (
                    f"Context '{name}' already exists. Do you want to create a new context? (y/n)"
                )
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

            self.send_response(200)
            self.end_headers()
        finally:
            exit(0)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, *args, **kwargs):
        return

    def log_error(self, *args, **kwargs):
        return

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()
