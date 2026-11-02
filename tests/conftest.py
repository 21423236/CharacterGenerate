import pytest
from fastapi.testclient import TestClient

from backend import config, jobs, store
from backend.app import app


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA", tmp_path)
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(store, "DB", tmp_path / "tasks.sqlite3")
    monkeypatch.setattr(jobs, "DATA", tmp_path)
    monkeypatch.setitem(config.DEFAULTS, "output_dir", str(tmp_path / "outputs"))
    for section in ("LLM", "IMAGE", "TRIPO"):
        monkeypatch.delenv(f"CHARACTER_FORGE_{section}_KEY", raising=False)
    store.init()
    return tmp_path


@pytest.fixture
def client(isolated):
    with TestClient(app, base_url="http://127.0.0.1:8765", headers={"X-Forge-Request": "local-ui"}) as client:
        yield client
