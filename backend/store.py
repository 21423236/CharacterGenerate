from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone

from .config import DATA

DB = DATA / "tasks.sqlite3"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connection():
    conn = sqlite3.connect(DB, timeout=20)
    conn.row_factory = sqlite3.Row
    return conn


def init():
    with connection() as conn:
        conn.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, payload TEXT NOT NULL,
          created TEXT NOT NULL, updated TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
          status TEXT NOT NULL, payload TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assets (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL,
          kind TEXT NOT NULL, name TEXT NOT NULL, created TEXT NOT NULL
        );
        """)
        if "deleted" not in {row["name"] for row in conn.execute("PRAGMA table_info(projects)")}:
            conn.execute("ALTER TABLE projects ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
        rows = conn.execute("SELECT * FROM jobs WHERE status IN ('queued','running')").fetchall()
        for row in rows:
            data = json.loads(row["payload"])
            data["message"] = "服务已重启，任务中断。付费任务不会自动重提；请先恢复查询或核对供应商任务记录。"
            conn.execute("UPDATE jobs SET status='interrupted', payload=?, updated=? WHERE id=?",
                         (json.dumps(data, ensure_ascii=False), now(), row["id"]))


def _project(row):
    if row is None:
        raise KeyError("项目不存在")
    return {**json.loads(row["payload"]), "id": row["id"], "title": row["title"], "created": row["created"], "updated": row["updated"]}


def list_projects():
    with connection() as conn:
        return [_project(row) for row in conn.execute("SELECT * FROM projects WHERE deleted=0 ORDER BY updated DESC")]


def get_project(project_id):
    with connection() as conn:
        return _project(conn.execute("SELECT * FROM projects WHERE id=? AND deleted=0", (project_id,)).fetchone())


def create_project(title):
    project_id = uuid.uuid4().hex
    data = {"prompt": "", "references": [], "sheet": None, "views": {}, "messages": [], "side": "left"}
    with connection() as conn:
        conn.execute("INSERT INTO projects (id,title,payload,created,updated) VALUES (?,?,?,?,?)", (project_id, title[:100] or "未命名角色", json.dumps(data), now(), now()))
    return get_project(project_id)


def update_project(project_id, changes):
    with connection() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id=? AND deleted=0", (project_id,)).fetchone()
        project = _project(row)
        project.update(changes)
        title = project.pop("title")
        for key in ("id", "created", "updated"):
            project.pop(key, None)
        conn.execute("UPDATE projects SET title=?, payload=?, updated=? WHERE id=?",
                     (title, json.dumps(project, ensure_ascii=False), now(), project_id))
    return get_project(project_id)


def delete_project(project_id):
    with connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _project(conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone())
        if conn.execute("SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')", (project_id,)).fetchone():
            raise ValueError("角色正在处理任务，请等待完成后再删除。")
        conn.execute("UPDATE projects SET deleted=1 WHERE id=?", (project_id,))
    return {"id": project_id, "deleted": True}


def restore_project(project_id):
    with connection() as conn:
        _project(conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone())
        conn.execute("UPDATE projects SET deleted=0 WHERE id=?", (project_id,))
    return get_project(project_id)


def create_job(project_id, kind):
    with connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _project(conn.execute("SELECT * FROM projects WHERE id=? AND deleted=0", (project_id,)).fetchone())
        if conn.execute("SELECT 1 FROM jobs WHERE project_id=? AND status IN ('queued','running')", (project_id,)).fetchone():
            raise ValueError("此项目已有任务正在运行，请等待完成。")
        job_id = uuid.uuid4().hex
        conn.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?)", (job_id, project_id, kind, "queued", "{}", now(), now()))
    return get_job(job_id)


def _job(row):
    if row is None:
        raise KeyError("任务不存在")
    return {**json.loads(row["payload"]), **{k: row[k] for k in ("id", "project_id", "kind", "status", "created", "updated")}}


def get_job(job_id):
    with connection() as conn:
        return _job(conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())


def list_jobs(project_id):
    with connection() as conn:
        return [_job(row) for row in conn.execute("SELECT * FROM jobs WHERE project_id=? ORDER BY created DESC", (project_id,))]


def update_job(job_id, status=None, **changes):
    with connection() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise KeyError("任务不存在")
        payload = json.loads(row["payload"])
        payload.update(changes)
        conn.execute("UPDATE jobs SET status=?, payload=?, updated=? WHERE id=?",
                     (status or row["status"], json.dumps(payload, ensure_ascii=False), now(), job_id))
    return get_job(job_id)


def add_asset(project_id, path, kind):
    from pathlib import Path
    path = Path(path).resolve()
    asset_id = uuid.uuid4().hex
    with connection() as conn:
        conn.execute("INSERT INTO assets VALUES (?,?,?,?,?,?)", (asset_id, project_id, str(path), kind, path.name, now()))
    return {"id": asset_id, "name": path.name, "kind": kind, "url": f"/api/assets/{asset_id}"}


def get_asset(asset_id, project_id=None):
    with connection() as conn:
        row = conn.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
    if row is None or (project_id and row["project_id"] != project_id):
        raise KeyError("文件不存在或不属于当前项目")
    return dict(row)
