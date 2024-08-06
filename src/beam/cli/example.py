import io
import os
import zipfile
from collections import defaultdict
from dataclasses import dataclass
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
    help="Downloads an examlpe app.",
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
    files = download_repo()
    if not files:
        return terminal.error(f"No files found in the repository {repo_uri}.")

    app_dir = find_app_dirs_by_name(name, files)
    if not app_dir:
        return terminal.error(f"App example '{name}' not found in repository {repo_uri}.")

    terminal.header(f"Creating app {name}...")
    for file in app_dir.files:
        terminal.detail(f"Writing {file.path}")
        file.path.parent.mkdir(parents=True, exist_ok=True)
        file.path.write_bytes(file.content)

    terminal.success(f"App example '{name}' created! 🎉")


@management.command(
    name="list",
    help="List all available example apps.",
)
def list_examples():
    files = download_repo()
    app_dirs = find_app_dirs(files)

    table = Table(
        Column("Name"),
        Column("Size", justify="right"),
        box=box.SIMPLE,
    )

    for app in app_dirs:
        table.add_row(
            app.path.as_posix(),
            terminal.humanize_memory(sum(len(f.content) for f in app.files)),
        )

    table.add_section()
    table.add_row(f"[bold]{len(app_dirs)} items")
    terminal.print(table)


@dataclass
class RepoFile:
    path: Path
    content: bytes


@dataclass
class AppDir:
    path: Path
    files: List[RepoFile]


def download_repo(url: str = repo_archive_uri) -> List[RepoFile]:
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

    return sorted(files, key=lambda f: f.path.name)


def find_app_dirs(files: List[RepoFile]) -> List[AppDir]:
    dirs: DefaultDict[Path, List[RepoFile]] = defaultdict(list)

    # Group files by parent directory
    for file in files:
        dirs[file.path.parent].append(file)

    return sorted(
        [AppDir(path=path, files=files) for path, files in dirs.items() if has_readme(files)],
        key=lambda d: d.path.as_posix(),
    )


def find_app_dirs_by_name(name: str, files: List[RepoFile]) -> Optional[AppDir]:
    apps = find_app_dirs(files)
    return next((app for app in apps if app.path.as_posix() == name), None)


def has_readme(files: List[RepoFile]) -> bool:
    return any(f.path.name.upper().endswith("README.MD") for f in files)
