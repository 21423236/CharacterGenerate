from __future__ import annotations

import asyncio
import mimetypes
import subprocess
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import jobs, processes, store
from .config import ROOT, PORT, load_settings, redact, save_settings
from .images import MAX_IMAGE_BYTES, decode_image, split_views, suggest_boxes
from .providers import endpoint
from .models import validate_glb


@asynccontextmanager
async def lifespan(app):
    store.init()
    yield
    tasks = list(jobs.TASKS.values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="角色工坊 · Character Forge", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware("http")
async def local_only(request: Request, call_next):
    host = request.url.hostname
    if host not in ("127.0.0.1", "localhost", "::1"):
        return JSONResponse({"detail": "仅接受本机访问"}, status_code=403)
    origin = request.headers.get("origin")
    if origin:
        parsed = urlparse(origin)
        if parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.port not in (PORT, 5173):
            return JSONResponse({"detail": "不允许的请求来源"}, status_code=403)
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-forge-request") != "local-ui":
        return JSONResponse({"detail": "缺少本地工具请求标记"}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    if request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(ValueError)
async def invalid(request, exc):
    return JSONResponse({"detail": redact(str(exc))}, status_code=400)


@app.exception_handler(KeyError)
async def missing(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.exception_handler(Exception)
async def unexpected(request, exc):
    return JSONResponse({"detail": redact(str(exc)) or "处理失败"}, status_code=500)


class ProviderConfig(BaseModel):
    base_url: str = Field(max_length=2048)
    model: str = Field(max_length=200)
    api_key: str = Field(default="", max_length=4096)
    vision: bool = False
    size: str = Field(default="1536x1024", max_length=30)
    response_format: Literal["auto", "b64_json", "url"] = "auto"

    @field_validator("base_url")
    @classmethod
    def valid_url(cls, value):
        endpoint(value, "test")
        return value


class TripoConfig(BaseModel):
    mode: Literal["studio", "api"] = "studio"
    studio_topology: Literal["triangle", "quad"] = "triangle"
    studio_face_limit: int = Field(default=15000, ge=500, le=50000)
    region: Literal["cn", "ov"] = "cn"
    api_key: str = Field(default="", max_length=4096)
    model: Literal["tripo-v3.1", "tripo-p1", "tripo-p2"] = "tripo-v3.1"
    face_limit: int = Field(default=50000, ge=500, le=150000)


class BlenderConfig(BaseModel):
    executable: str = Field(max_length=4096)
    template: str = Field(max_length=4096)
    armature: str = Field(max_length=200)
    body: str = Field(max_length=200)
    head: str = Field(default="", max_length=200)
    influences: int = Field(default=4, ge=1, le=8)


class Settings(BaseModel):
    llm: ProviderConfig
    image: ProviderConfig
    tripo: TripoConfig
    blender: BlenderConfig
    output_dir: str = Field(min_length=1, max_length=4096)


class ProjectCreate(BaseModel):
    title: str = Field(default="新角色", max_length=100)


class ProjectUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=100)
    prompt: str | None = Field(default=None, max_length=18000)
    side: Literal["left", "right"] | None = None


class Transform(BaseModel):
    rotation_x: float = Field(default=0, ge=-360, le=360, allow_inf_nan=False)
    rotation_y: float = Field(default=0, ge=-360, le=360, allow_inf_nan=False)
    rotation_z: float = Field(default=0, ge=-360, le=360, allow_inf_nan=False)
    scale: float = Field(default=1, ge=.1, le=5, allow_inf_nan=False)
    offset_x: float = Field(default=0, ge=-10, le=10, allow_inf_nan=False)
    offset_y: float = Field(default=0, ge=-10, le=10, allow_inf_nan=False)
    offset_z: float = Field(default=0, ge=-10, le=10, allow_inf_nan=False)


class JobRequest(BaseModel):
    kind: Literal["chat", "image", "inspect", "model", "resume", "align", "bind", "doctor"]
    message: str = Field(default="", max_length=8000)
    transform: Transform = Field(default_factory=Transform)
    remote_id: str = Field(default="", max_length=100)
    confirmed: bool = False


class CropRequest(BaseModel):
    boxes: list[list[float]] = Field(min_length=3, max_length=3)
    labels: list[Literal["front", "left", "right", "back"]] = Field(min_length=3, max_length=3)
    confirmed: bool


@app.get("/api/health")
def health():
    return {"ok": True, "version": "0.3.0", "app": "character-forge", "capabilities": ["studio-import", "studio-automation"]}


@app.get("/api/settings")
def settings_get():
    return load_settings(public=True)


@app.put("/api/settings")
def settings_put(body: Settings):
    if body.tripo.studio_topology == "quad" and body.tripo.studio_face_limit > 25000:
        raise ValueError("网页智能网格四边面预算不能超过 25000")
    if body.tripo.model == "tripo-p1" and body.tripo.face_limit > 20000:
        raise ValueError("Tripo P1 面数预算不能超过 20000")
    if body.tripo.model == "tripo-p2" and body.tripo.face_limit > 50000:
        raise ValueError("Tripo P2 面数预算不能超过 50000")
    return save_settings(body.model_dump())


@app.get("/api/projects")
def projects_get():
    return store.list_projects()


@app.post("/api/projects")
def projects_create(body: ProjectCreate):
    return store.create_project(body.title)


@app.delete("/api/projects/{project_id}")
def projects_delete(project_id: str):
    return store.delete_project(project_id)


@app.post("/api/projects/{project_id}/restore")
def projects_restore(project_id: str):
    return store.restore_project(project_id)


@app.get("/api/projects/{project_id}")
def project_get(project_id: str):
    return store.get_project(project_id)


def ensure_idle(project_id):
    if any(job["status"] in ("queued", "running") for job in store.list_jobs(project_id)):
        raise ValueError("项目正在处理任务，请完成后再修改输入")


@app.patch("/api/projects/{project_id}")
def project_update(project_id: str, body: ProjectUpdate):
    ensure_idle(project_id)
    return store.update_project(project_id, body.model_dump(exclude_none=True))


@app.get("/api/projects/{project_id}/jobs")
def jobs_get(project_id: str):
    store.get_project(project_id)
    return store.list_jobs(project_id)


@app.post("/api/projects/{project_id}/jobs")
async def jobs_create(project_id: str, body: JobRequest):
    project = store.get_project(project_id)
    if body.kind == "model" and load_settings()["tripo"]["mode"] != "api":
        raise ValueError("当前为网页会员模式，请打开 Tripo 工作台生成；API 建模需在设置中显式切换")
    if body.kind in ("model", "image", "bind") and not body.confirmed:
        raise ValueError("此操作需要用户确认")
    if body.kind == "image" and not project.get("prompt", "").strip():
        raise ValueError("请先填写角色设计提示词")
    if body.kind == "chat" and not body.message.strip():
        raise ValueError("请输入消息")
    return jobs.launch(project_id, body.kind, body.model_dump(exclude={"kind", "confirmed"}))


@app.post("/api/projects/{project_id}/upload")
async def upload(project_id: str, kind: Literal["reference", "sheet", "model"], file: UploadFile = File(...),
                 source: Literal["manual", "studio"] = "manual", expected_model_id: str | None = None):
    project = store.get_project(project_id)
    ensure_idle(project_id)
    limit = 100 * 1024 * 1024 if kind == "model" else MAX_IMAGE_BYTES
    raw = await file.read(limit + 1)
    ensure_idle(project_id)
    project = store.get_project(project_id)
    if len(raw) > limit:
        raise ValueError(f"文件大小超过 {limit // 1024 // 1024} MB")
    destination = jobs.project_dir(project_id) / "uploads"
    destination.mkdir(parents=True, exist_ok=True)
    if kind == "model":
        validate_glb(raw)
        if source == "studio" and expected_model_id is not None and (project.get("model") or {}).get("id", "") != expected_model_id:
            raise ValueError("项目模型已更改，下载文件已保留。请在 Tripo 工具栏使用‘导入已下载 GLB’选择需要的版本")
        path = destination / f"{uuid.uuid4().hex}.glb"
        path.write_bytes(raw)
        asset = store.add_asset(project_id, path, "model")
        result = store.update_project(project_id, {"model": asset, "alignment": None, "rig": None, "model_preview": None})
        if source == "studio":
            job = store.create_job(project_id, "studio_import")
            store.update_job(job["id"], "success", progress=100, message="Tripo 网页模型已导入", result={"assets": {"model": asset}})
        return result
    image = await asyncio.to_thread(decode_image, raw)
    if kind == "reference" and len(project.get("references", [])) >= 8:
        raise ValueError("最多使用 8 张参考图")
    path = destination / f"{uuid.uuid4().hex}.png"
    image.save(path)
    asset = store.add_asset(project_id, path, "image")
    if kind == "reference":
        return store.update_project(project_id, {"references": project.get("references", []) + [asset]})
    boxes = await asyncio.to_thread(suggest_boxes, image)
    return store.update_project(project_id, {"sheet": asset, "boxes": boxes, "views": {}, "sheet_revision": asset["id"]})


@app.delete("/api/projects/{project_id}/references/{asset_id}")
def remove_reference(project_id: str, asset_id: str):
    ensure_idle(project_id)
    project = store.get_project(project_id)
    return store.update_project(project_id, {"references": [a for a in project.get("references", []) if a["id"] != asset_id]})


@app.post("/api/projects/{project_id}/crop")
async def crop(project_id: str, body: CropRequest):
    ensure_idle(project_id)
    project = store.get_project(project_id)
    if not project.get("sheet") or not body.confirmed:
        raise ValueError("需要先选择三视图并确认裁切与视角标签")
    asset = store.get_asset(project["sheet"]["id"], project_id)
    from PIL import Image
    with Image.open(asset["path"]) as image:
        paths, warnings = await asyncio.to_thread(split_views, image.convert("RGBA"), body.boxes, body.labels,
                                                  jobs.project_dir(project_id) / "views" / uuid.uuid4().hex)
    views = {label: store.add_asset(project_id, path, "image") for label, path in paths.items()}
    side = "left" if "left" in views else "right"
    return store.update_project(project_id, {"views": views, "boxes": body.boxes, "side": side, "view_warnings": warnings})


@app.get("/api/assets/{asset_id}")
def asset_get(asset_id: str, download: bool = False):
    asset = store.get_asset(asset_id)
    path = Path(asset["path"])
    if not path.is_file():
        raise HTTPException(404, "文件已移动或删除")
    media = "model/gltf-binary" if path.suffix.lower() == ".glb" else mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media, filename=path.name if download else None)


class BrowseRequest(BaseModel):
    kind: Literal["executable", "template", "output"]


@app.post("/api/browse")
async def browse(body: BrowseRequest):
    def dialog():
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        try:
            if body.kind == "output":
                return filedialog.askdirectory(title="选择角色输出目录")
            filters = [("Blender", "*.exe")] if body.kind == "executable" else [("Blender 工程", "*.blend")]
            return filedialog.askopenfilename(title="选择 Blender 程序或模板", filetypes=filters)
        finally:
            root.destroy()
    return {"path": await asyncio.to_thread(dialog)}


@app.post("/api/projects/{project_id}/open-blender")
async def open_blender(project_id: str):
    project = store.get_project(project_id)
    rig = project.get("rig")
    if not rig or not rig.get("assets", {}).get("blend"):
        raise ValueError("请先完成蒙皮，生成新的 Blender 工程")
    path = store.get_asset(rig["assets"]["blend"]["id"], project_id)["path"]
    executable = processes.blender_executable(load_settings()["blender"])
    subprocess.Popen([str(executable), "--disable-autoexec", path], cwd=ROOT, close_fds=True)
    return {"ok": True}


dist = ROOT / "web" / "dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="ui")
