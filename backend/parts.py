"""Component projects share existing crop/model/job workflows, but belong to one character."""
import json
import re
import shutil
import threading
from pathlib import Path

from . import store
from .config import load_settings

KINDS = {"body": "基础身体", "hair": "发型", "top": "上衣", "coat": "外套", "bottom": "裤子或裙子",
         "shoes": "鞋子（一双）", "gloves": "手套（一双）", "accessory": "大型配件"}
_folder_locks = {}


def normalize_suggestions(items):
    result, paired = [], set()
    for item in items:
        kind = item["kind"]
        if kind in ("shoes", "gloves"):
            if kind in paired:
                continue
            paired.add(kind)
            item = {**item, "title": KINDS[kind]}
        result.append(item)
    return result


def children(project_id):
    return [p for p in store.list_projects() if p.get("parent_id") == project_id]


def root(project):
    return store.get_project(project["parent_id"]) if project.get("parent_id") else project


def folder(project):
    parent = root(project)
    base = Path(load_settings()["output_dir"]).expanduser().resolve() / parent["id"]
    if project.get("parent_id"):
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', project["title"]).strip(' .')[:50] or "部件"
        base = base / "部件" / (name + "_" + project["id"][:8])
    return base


def create(parent_id, title, kind):
    parent = store.get_project(parent_id)
    if parent.get("parent_id"):
        raise ValueError("请在角色总项目下创建部件")
    if not parent.get("sheet"):
        raise ValueError("请先生成或导入角色总图")
    if kind not in KINDS:
        raise ValueError("未知部件类型")
    if len(children(parent_id)) >= 30:
        raise ValueError("一个角色最多 30 个部件")
    project = store.create_project(title or KINDS[kind], {"parent_id": parent_id, "part_kind": kind,
        "prompt": f"从参考角色中提取{title or KINDS[kind]}，保持原造型、配色、材质和非对称细节。",
        "source_sheet_id": parent["sheet"]["id"], "split_model": False, "binding_mode": "surface", "binding_bone": ""})
    original = store.get_asset(parent["sheet"]["id"], parent_id)
    reference = store.add_asset(project["id"], original["path"], "image")
    store.update_project(parent_id, {"rig": None})
    return store.update_project(project["id"], {"references": [reference]})


def organize(project_id):
    parent = root(store.get_project(project_id))
    with _folder_locks.setdefault(parent["id"], threading.Lock()):
        return _organize(parent)


def _organize(parent):
    members = [parent, *children(parent["id"])]
    base = folder(parent)
    base.mkdir(parents=True, exist_ok=True)
    manifest = {"version": 1, "character": parent["title"], "project_id": parent["id"], "projects": []}
    for project in members:
        assets = []
        for asset in store.list_assets(project["id"]):
            source = Path(asset["path"])
            if not source.is_file():
                assets.append({"id": asset["id"], "missing": True, "name": asset["name"]})
                continue
            destination = folder(project) / asset["kind"] / (asset["id"] + "_" + source.name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.resolve() != destination.resolve() and not destination.exists():
                shutil.copy2(source, destination)
            assets.append({"id": asset["id"], "kind": asset["kind"], "file": destination.relative_to(base).as_posix()})
        manifest["projects"].append({"id": project["id"], "title": project["title"], "kind": project.get("part_kind", "character"),
            "split_model": project.get("split_model", False), "source_sheet_id": project.get("source_sheet_id"),
            "current_model": project.get("model"), "binding_mode": project.get("binding_mode"),
            "binding_bone": project.get("binding_bone"), "assets": assets})
    # Publish the inventory only after all copies in this snapshot are complete.
    import uuid
    temporary = base / (uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(base / "资产清单.json")
    return {"path": str(base), "count": sum(len(p["assets"]) for p in manifest["projects"])}
