import io
import os
import zipfile
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import DefaultDict, List, Optional

import click
import requests
from beta9 import terminal
from beta9.cli.extraclick import ClickCommonGroup, ClickManagementGroup
from rich.table import Column, Table, box

# GIT_REPO_ZIP_FILE defaults to the main branch.
repo_zip = os.getenv("GIT_REPO_ZIP_FILE") or "main.zip"
repo_uri = os.getenv("GIT_REPO_URL") or "https://github.com/beam-cloud/examples"
repo_archive_uri = f"{repo_uri}/archive/refs/heads/{repo_zip}"


@click.group(cls=ClickCommonGroup)
def common(**_):
    pass


@click.group(
    name="example",
    cls=ClickManagementGroup,
    help="Manage example apps.",
)
def management(**_):
    pass


@common.command(
    name="create-app",
    help="Downloads an example app.",
)
@click.argument(
    "name",
    type=str,
    nargs=1,
    required=True,
)
@click.pass_context
def create_app(ctx: click.Context, name: str):
    ctx.invoke(download_example, name=name)


@management.command(
    name="download",
    help="Downloads an example app.",
)
@click.argument(
    "name",
    type=str,
    nargs=1,
    required=True,
)
def download_example(name: str):
    terminal.header("Downloading contents")
    dirs = download_repo()
    if not dirs:
        return terminal.error(f"No files found in the repository {repo_uri}.")

    if name == "all":
        terminal.header("Getting all examples")
        app_dirs = find_app_dirs(dirs)
        if not app_dirs:
            return terminal.error(f"No example apps found in repository {repo_uri}.")
    else:
        terminal.header(f"Getting {name} example")
        app_dir = find_app_dirs_by_name(name, dirs)
        if not app_dir:
            return terminal.error(f"App example '{name}' not found in repository {repo_uri}.")
        app_dirs = [app_dir]

    for app in app_dirs:
        terminal.header(f"Writing {app.path} example")
        for file in app.files:
            path = "examples" / file.path if name == "all" else file.path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(file.content)

    terminal.success("=> Completed! 🎉")


@management.command(
    name="list",
    help="List all available example apps.",
)
def list_examples():
    dirs = download_repo()
    app_dirs = find_app_dirs(dirs)

    table = Table(
        Column("Name"),
        Column("Size", justify="right"),
        box=box.SIMPLE,
    )

    if app_dirs:
        table.add_row(
            "all",
            terminal.humanize_memory(sum(len(f.content) for app in app_dirs for f in app.files)),
        )

    for app in app_dirs:
        table.add_row(
            app.path.as_posix(),
            terminal.humanize_memory(sum(len(f.content) for f in app.files)),
        )

    table.add_section()
    table.add_row(f"[bold]{len(app_dirs) + 1} items")
    terminal.print(table)


@dataclass
class RepoFile:
    path: Path
    content: bytes


@dataclass
class RepoDir:
    path: Path = Path()
    files: List[RepoFile] = field(default_factory=list)


def download_repo(url: str = repo_archive_uri) -> List[RepoDir]:
    """
    Downloads the repository into memory and returns a list of RepoDirs.
    """
    response = requests.get(url)
    response.raise_for_status()

    files: List[RepoFile] = []
    with zipfile.ZipFile(io.BytesIO(response.content)) as zip:
        for file_info in zip.infolist():
            if file_info.is_dir():
                continue
            with zip.open(file_info) as file:
                path = Path(*file_info.filename.split("/")[1:])
                files.append(RepoFile(path=path, content=file.read()))

    files.sort(key=lambda f: f.path.name)

    dirs: DefaultDict[Path, RepoDir] = defaultdict(RepoDir)
    for file in files:
        repo_dir = dirs[file.path.parent]
        repo_dir.path = file.path.parent
        repo_dir.files.append(file)

    return list(dirs.values())


def find_app_dirs(dirs: List[RepoDir]) -> List[RepoDir]:
    """
    Finds example app dirs.

    An example app dir is a directory containing a README.md file.
    """
    return sorted(
        [RepoDir(path=d.path, files=d.files) for d in dirs if has_readme(d.files)],
        key=lambda d: d.path.as_posix(),
    )


def find_app_dirs_by_name(name: str, dirs: List[RepoDir]) -> Optional[RepoDir]:
    """
    Finds an example app dir by name.
    """
    apps = find_app_dirs(dirs)
    return next((app for app in apps if app.path.as_posix() == name), None)


def has_readme(files: List[RepoFile]) -> bool:
    return any(f.path.name.upper().endswith("README.MD") for f in files)
