from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from . import processes, providers, store
from .config import DATA, load_settings, redact
from .images import suggest_boxes
from .models import validate_model

TASKS: dict[str, asyncio.Task] = {}


def project_dir(project_id):
    path = DATA / "projects" / project_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def output_dir(settings, project_id, job_id):
    path = Path(settings["output_dir"]).expanduser().resolve() / project_id / job_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def launch(project_id, kind, options=None):
    job = store.create_job(project_id, kind)
    task = asyncio.create_task(execute_job(job, options or {}))
    TASKS[job["id"]] = task
    task.add_done_callback(lambda _: TASKS.pop(job["id"], None))
    return job


def asset_result(project_id, result, mapping):
    assets = {}
    for key, kind in mapping.items():
        if result.get(key) and Path(result[key]).is_file():
            assets[key] = store.add_asset(project_id, result[key], kind)
    return assets


async def watch_model(job, settings, remote_id, destination):
    def progress(event):
        if event.get("event") == "progress":
            store.update_job(job["id"], progress=event.get("progress", 0), message="Tripo 正在生成模型")
    result = await processes.tripo(["task", "watch", remote_id, "--download", "--out", str(destination), "--timeout", "1800"], settings, progress)
    if not result.get("model_file") or not Path(result["model_file"]).is_file():
        raise RuntimeError("云端任务可能已成功，但未获得模型文件。请使用恢复查询重试下载，不要重新生成。")
    validate_model(Path(result["model_file"]))
    assets = asset_result(job["project_id"], {"model": result.get("model_file"), "preview": result.get("preview")}, {"model": "model", "preview": "image"})
    store.update_project(job["project_id"], {"model": assets["model"], "model_preview": assets.get("preview"), "alignment": None, "rig": None})
    return {"assets": assets, "credits": result.get("credits_consumed"), "remote_id": remote_id}


async def execute_job(job, options):
    job_id, project_id, kind = job["id"], job["project_id"], job["kind"]
    store.update_job(job_id, "running", message="准备任务", progress=0)
    try:
        settings = load_settings()
        project = store.get_project(project_id)
        destination = output_dir(settings, project_id, job_id)
        if kind == "chat":
            reply = await providers.design_brief(settings, project, options["message"])
            messages = project.get("messages", []) + [{"role": "user", "content": options["message"]}, {"role": "assistant", "content": reply["reply"]}]
            store.update_project(project_id, {"prompt": reply["prompt"], "messages": messages[-60:]})
            result = {"reply": reply["reply"]}
        elif kind == "image":
            inspection = project.get("inspection")
            pose_note = ""
            if inspection:
                try:
                    template = processes.template_path(settings["blender"])
                    current = (inspection.get("template") == str(template)
                               and inspection.get("template_mtime") == template.stat().st_mtime_ns
                               and inspection.get("armature") == settings["blender"]["armature"])
                except (ValueError, OSError):
                    current = False
                if not current:
                    # Template pose is optional for image generation. Keep the
                    # stored inspection for review, but never send stale pose data.
                    project = {**project, "inspection": None}
                    pose_note = "骨架模板姿态不可用，本次使用默认 A-pose。"
            store.update_job(job_id, message=pose_note + "已提交生图请求，请勿重复点击；此操作可能计费")
            image, prompt = await providers.generate_image(settings, project)
            path = destination / "turnaround.png"
            image.save(path)
            (destination / "prompt.txt").write_text(prompt, encoding="utf-8")
            asset = store.add_asset(project_id, path, "image")
            boxes = suggest_boxes(image)
            store.update_project(project_id, {"sheet": asset, "boxes": boxes, "views": {}, "alignment": None, "rig": None, "sheet_revision": job_id})
            result = {"asset": asset, "assets": {"sheet": asset}, "boxes": boxes, "message": pose_note + "新三视图已生成，请确认设计一致性，并手动校正裁切框和视角标签"}
        elif kind == "inspect":
            store.update_job(job_id, message="只读检测骨架、人体权重和静止姿态")
            result = await processes.blender({"action": "inspect", "config": settings["blender"]}, destination)
            result["template"] = str(processes.template_path(settings["blender"]))
            result["template_mtime"] = processes.template_path(settings["blender"]).stat().st_mtime_ns
            store.update_project(project_id, {"inspection": result})
        elif kind == "model":
            if settings["tripo"].get("mode", "studio") != "api":
                raise ValueError("网页会员模式请在 Tripo 工作台生成模型")
            views = project.get("views", {})
            side = project.get("side", "left")
            if not all(label in views for label in ("front", side, "back")):
                raise ValueError("请先拆分并确认三视图")
            paths = [store.get_asset(views[label]["id"], project_id)["path"] for label in ("front", side, "back")]
            config = settings["tripo"]
            face_limit = int(config["face_limit"])
            model = config["model"]
            if face_limit <= 20000 and model == "tripo-v3.1":
                model = "tripo-p1"
            store.update_job(job_id, message="正在提交多视图建模任务；不会自动重复提交", submission_started=True,
                             tripo_region=config["region"])
            result = await processes.tripo(["generate", "multiview-to-model", *paths, "--model", model,
                                             "-p", f"face_limit={face_limit}", "-p", "texture=true", "-p", "pbr=true", "--no-wait"], settings)
            remote_id = result.get("task_id")
            if not remote_id:
                raise providers.SubmissionUncertain("Tripo 未返回任务 ID。请先核对供应商记录后再提交。")
            store.update_job(job_id, remote_id=remote_id, message="任务 ID 已保存，正在等待建模完成")
            result = await watch_model(job, settings, remote_id, destination)
        elif kind == "resume":
            remote_id = options["remote_id"]
            if not re.fullmatch(r"[a-zA-Z0-9_-]{8,100}", remote_id):
                raise ValueError("无效的 Tripo 任务 ID")
            store.update_job(job_id, remote_id=remote_id, message="仅查询和下载已有任务，不创建新建模任务")
            result = await watch_model(job, settings, remote_id, destination)
        elif kind in ("align", "bind"):
            if not project.get("model"):
                raise ValueError("请先生成或导入模型")
            model_path = store.get_asset(project["model"]["id"], project_id)["path"]
            transform = options.get("transform", {})
            if kind == "bind":
                alignment = project.get("alignment")
                if not alignment or alignment.get("model_id") != project["model"]["id"] or alignment.get("transform") != transform:
                    raise ValueError("请先按当前参数生成对齐预览，确认后再蒙皮")
                if alignment.get("config") != settings["blender"] or alignment.get("template_mtime") != processes.template_path(settings["blender"]).stat().st_mtime_ns:
                    raise ValueError("模板或蒙皮设置已更改，请重新生成对齐预览")
            store.update_job(job_id, message="正在 Blender 中处理；源模板不会保存或覆盖")
            result = await processes.blender({"action": kind, "config": settings["blender"], "model": model_path,
                                              "transform": transform, "output": str(destination)}, destination)
            assets = asset_result(project_id, result, {"aligned": "model", "reference": "model", "blend": "blend", "glb": "model", "fbx": "model"})
            if kind == "align":
                store.update_project(project_id, {"alignment": {"assets": assets, "transform": transform, "model_id": project["model"]["id"],
                                                                 "config": settings["blender"], "template_mtime": processes.template_path(settings["blender"]).stat().st_mtime_ns}})
            else:
                tests = [{"name": test["name"], "asset": store.add_asset(project_id, test["path"], "model")} for test in result.get("tests", [])]
                result = {"assets": assets, "weights": result.get("weights"), "warnings": result.get("warnings"), "tests": tests}
                store.update_project(project_id, {"rig": result})
            result["assets"] = assets
        elif kind == "doctor":
            result = await processes.tripo(["doctor"], settings)
            result["message"] = "\n".join(f"{'✓' if item.get('ok') else '!'} {item.get('name')}: {item.get('detail')}" for item in result.get("checks", [])) or "Tripo 检查完成"
        else:
            raise ValueError("未知任务类型")
        store.update_job(job_id, "success", progress=100, message=result.get("message", "任务完成"), result=result)
    except Exception as exc:
        current = store.get_job(job_id)
        ambiguous = isinstance(exc, providers.SubmissionUncertain) or (kind == "model" and current.get("submission_started") and not current.get("remote_id"))
        status = "uncertain" if ambiguous else "failed"
        store.update_job(job_id, status, message=redact(str(exc)), needs_review=ambiguous)
