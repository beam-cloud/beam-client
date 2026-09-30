"""`beam` knows production and the other Beam environments by name."""

import sys

import pytest
from beta9.config import context_defaults, get_settings, load_config
from click.testing import CliRunner


@pytest.fixture
def main(monkeypatch, tmp_path):
    monkeypatch.setenv("BEAM_TOKEN", "t" * 64)  # no first-run prompt while importing
    monkeypatch.setenv("CONFIG_PATH", str(tmp_path / "config.ini"))
    sys.modules.pop("beam.cli.main", None)
    import beam.cli.main as module

    assert get_settings() is module.settings
    return module


def test_environments_point_at_their_own_cluster(main):
    default = context_defaults()
    assert (default.gateway_host, default.auth_url) == (
        "gateway.beam.cloud",
        "https://api.beam.cloud/v2/oauth",
    )

    staging = context_defaults("staging")
    assert (staging.gateway_host, staging.api_url, staging.auth_url) == (
        "gateway.stage.beam.cloud",
        "https://app.stage.beam.cloud",
        "https://api.stage.beam.cloud/v2/oauth",
    )
    assert context_defaults("local").auth_url == "http://127.0.0.1:8008/v2/oauth"


def test_configure_saves_a_context_that_points_where_its_name_says(main):
    from beam.cli import configure

    result = CliRunner().invoke(configure.common, ["configure", "staging", "--token", "s" * 64])
    assert result.exit_code == 0, result.output

    saved = load_config()["staging"]
    assert (saved.token, saved.gateway_host, saved.auth_url) == (
        "s" * 64,
        "gateway.stage.beam.cloud",
        "https://api.stage.beam.cloud/v2/oauth",
    )
