import asyncio
import base64
import copy
import io
import json
import struct

import httpx
import pytest
from PIL import Image, ImageDraw

from backend import config, jobs, processes, providers, store
from backend.images import decode_image, split_views, suggest_boxes
from backend.models import validate_glb


def sheet_bytes():
    image = Image.new("RGB", (900, 600), "white")
    draw = ImageDraw.Draw(image)
    for center, width in ((150, 100), (450, 60), (750, 100)):
        draw.rectangle((center-width/2, 40, center+width/2, 560), fill="#843d45")
    stream = io.BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


def glb(document):
    raw = json.dumps(document).encode()
    raw += b" " * ((4-len(raw)%4)%4)
    return b"glTF" + struct.pack("<IIII", 2, len(raw)+20, len(raw), 0x4E4F534A) + raw


def test_crop_preserves_scale_and_labels(tmp_path):
    image = decode_image(sheet_bytes())
    boxes = suggest_boxes(image)
    assert len(boxes) == 3
    paths, warnings = split_views(image, boxes, ["front", "left", "back"], tmp_path)
    assert set(paths) == {"front", "left", "back"}
    assert all(Image.open(p).size == (1024, 1024) for p in paths.values())
    assert not warnings
    with pytest.raises(ValueError):
        split_views(image, boxes, ["front", "left", "left"], tmp_path)
    with pytest.raises(ValueError):
        split_views(image, [[-1,0,.3,1], boxes[1], boxes[2]], ["front","left","back"], tmp_path)


def test_glb_rejects_remote_resources():
    validate_glb(glb({"asset":{"version":"2.0"}, "images":[{"bufferView":0}]}))
    with pytest.raises(ValueError, match="外部"):
        validate_glb(glb({"asset":{"version":"2.0"}, "images":[{"uri":"https://example.com/track.png"}]}))
    with pytest.raises(ValueError):
        validate_glb(b"not a model")


def test_dpapi_secrets_do_not_roundtrip_to_browser(isolated):
    key = "test-secret-do-not-persist-in-plaintext"
    result = config.save_settings({"llm":{"api_key":key, "model":"test"}})
    assert result["llm"]["has_key"]
    assert "api_key" not in result["llm"]
    assert key not in config.CONFIG_FILE.read_text(encoding="utf-8")
    assert config.load_settings()["llm"]["api_key"] == key
    config.save_settings({"llm":{"api_key":""}})
    assert config.load_settings()["llm"]["api_key"] == key
    assert key not in config.redact("Bearer " + key)


def test_interrupted_jobs_are_not_resubmitted(isolated):
    project = store.create_project("restart")
    job = store.create_job(project["id"], "model")
    store.update_job(job["id"], "running", remote_id="existing-task-id")
    with pytest.raises(ValueError):
        store.create_job(project["id"], "model")
    store.init()
    saved = store.get_job(job["id"])
    assert saved["status"] == "interrupted"
    assert saved["remote_id"] == "existing-task-id"


def test_local_origin_csrf_and_assets(client):
    assert client.get("/api/health").json()["ok"]
    assert client.get("/api/settings", headers={"Host":"evil.example"}).status_code == 403
    assert client.post("/api/projects", json={}, headers={"Origin":"https://evil.example"}).status_code == 403
    assert client.post("/api/projects", json={}, headers={"X-Forge-Request":""}).status_code == 403
    project = client.post("/api/projects", json={"title":"测试角色"}).json()
    other = client.post("/api/projects", json={"title":"隔离项目"}).json()
    base = f"/api/projects/{project['id']}"
    uploaded = client.post(base+"/upload?kind=sheet", files={"file":("sheet.png",sheet_bytes(),"image/png")})
    assert uploaded.status_code == 200
    data = uploaded.json()
    result = client.post(base+"/crop", json={"boxes":data["boxes"],"labels":["front","left","back"],"confirmed":True})
    assert result.status_code == 200
    views = result.json()["views"]
    assert client.get(views["front"]["url"]).headers["content-type"] == "image/png"
    with pytest.raises(KeyError):
        store.get_asset(views["front"]["id"], other["id"])
    assert client.post(base+"/jobs",json={"kind":"model"}).status_code==400
    assert client.post(base+"/jobs",json={"kind":"bind","confirmed":True,"transform":{"scale":-1}}).status_code==422


def test_agent_is_design_only_and_validates_tools(isolated, monkeypatch):
    project=store.create_project("design")
    captured=[]
    def handler(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200,json={"choices":[{"message":{"tool_calls":[{"function":{"name":"publish_design","arguments":json.dumps({"reply":"已整理设计","prompt":"完整游侠角色"})}}]}}]})
    original=httpx.AsyncClient
    monkeypatch.setattr(providers.httpx,"AsyncClient",lambda **kw: original(transport=httpx.MockTransport(handler),**kw))
    settings=copy.deepcopy(config.DEFAULTS)
    settings["llm"].update(model="model",api_key="fake-key")
    result=asyncio.run(providers.design_brief(settings,project,"设计游侠"))
    assert result["prompt"]=="完整游侠角色"
    assert len(captured[0]["tools"])==1
    assert captured[0]["tools"][0]["function"]["name"]=="publish_design"
    assert "fake-key" not in json.dumps(captured)


def test_image_submission_is_not_retried(isolated, monkeypatch):
    calls=[]
    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout("uncertain")
    original=httpx.AsyncClient
    monkeypatch.setattr(providers.httpx,"AsyncClient",lambda **kw: original(transport=httpx.MockTransport(handler),**kw))
    settings=copy.deepcopy(config.DEFAULTS)
    settings["image"].update(model="image-model",api_key="fake-key")
    with pytest.raises(providers.SubmissionUncertain):
        asyncio.run(providers.generate_image(settings,{"prompt":"角色","side":"left"}))
    assert len(calls)==1


@pytest.mark.parametrize("template_state", ["missing", "changed", "current"])
def test_regenerate_sheet_with_latest_design_and_optional_template(isolated, monkeypatch, template_state):
    project = store.create_project("new design")
    old_path = isolated / "old.png"
    old_path.write_bytes(sheet_bytes())
    old_sheet = store.add_asset(project["id"], old_path, "image")
    template = isolated / "template.blend"
    if template_state != "missing":
        template.write_bytes(b"test template metadata only")
    inspection = {"template": str(template), "template_mtime": template.stat().st_mtime_ns if template_state == "current" else 0,
                  "armature": "_COM", "pose_hint": "TEST CURRENT REST POSE"}
    store.update_project(project["id"], {"prompt": "a NEW blue robot", "sheet": old_sheet,
                                         "views": {"front": old_sheet}, "inspection": inspection})
    settings = copy.deepcopy(config.DEFAULTS)
    settings["output_dir"] = str(isolated / "outputs")
    settings["blender"]["template"] = str(template)
    settings["image"].update(model="image-model", api_key="fake-key")
    monkeypatch.setattr(jobs, "load_settings", lambda: settings)
    captured = []
    generated = Image.new("RGB", (900, 600), "blue")
    encoded = io.BytesIO()
    generated.save(encoded, format="PNG")
    def handler(request):
        assert request.url.path.endswith("/images/generations")
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(encoded.getvalue()).decode()}]})
    original = httpx.AsyncClient
    monkeypatch.setattr(providers.httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    job = store.create_job(project["id"], "image")
    asyncio.run(jobs.execute_job(job, {}))
    saved = store.get_job(job["id"])
    assert saved["status"] == "success", saved.get("message")
    assert len(captured) == 1
    assert "a NEW blue robot" in captured[0]["prompt"]
    assert ("TEST CURRENT REST POSE" in captured[0]["prompt"]) == (template_state == "current")
    if template_state != "current":
        assert "A-pose" in captured[0]["prompt"]
        assert "默认 A-pose" in saved["message"]
    fresh = store.get_project(project["id"])
    assert fresh["sheet"]["id"] != old_sheet["id"]
    assert fresh["views"] == {}
    assert fresh["inspection"] == inspection
    with Image.open(store.get_asset(fresh["sheet"]["id"])["path"]) as result:
        assert result.convert("RGB").getpixel((0, 0)) == (0, 0, 255)
    assert old_path.read_bytes() == sheet_bytes()


def test_reference_image_uses_edit_endpoint(isolated, monkeypatch):
    project=store.create_project("reference")
    source=isolated/"ref.png"
    source.write_bytes(sheet_bytes())
    reference=store.add_asset(project["id"],source,"image")
    project.update(prompt="完整角色",references=[reference])
    captured=[]
    def handler(request):
        captured.append(request)
        assert request.url.path=="/v1/images/edits"
        assert request.headers["content-type"].startswith("multipart/form-data")
        assert b'name="image[]"' in request.content
        return httpx.Response(200,json={"data":[{"b64_json":base64.b64encode(sheet_bytes()).decode()}]})
    original=httpx.AsyncClient
    monkeypatch.setattr(providers.httpx,"AsyncClient",lambda **kw: original(transport=httpx.MockTransport(handler),**kw))
    settings=copy.deepcopy(config.DEFAULTS)
    settings["image"].update(model="image",api_key="fake-key")
    image,prompt=asyncio.run(providers.generate_image(settings,project))
    assert image.size==(900,600)
    assert "EXACTLY THREE" in prompt
    assert len(captured)==1


def test_artifact_download_does_not_forward_key(isolated, monkeypatch):
    calls=[]
    def handler(request):
        calls.append(request)
        if request.method=="POST":
            assert request.headers["authorization"]=="Bearer fake-key"
            return httpx.Response(200,json={"data":[{"url":"https://cdn.example.com/image.png?signature=signed"}]})
        assert "authorization" not in request.headers
        return httpx.Response(200,content=sheet_bytes())
    original=httpx.AsyncClient
    monkeypatch.setattr(providers.httpx,"AsyncClient",lambda **kw: original(transport=httpx.MockTransport(handler),**kw))
    settings=copy.deepcopy(config.DEFAULTS)
    settings["image"].update(model="image",api_key="fake-key")
    image,_=asyncio.run(providers.generate_image(settings,{"prompt":"角色"}))
    assert image.width==900
    assert len(calls)==2


def test_binding_requires_preview_of_same_settings(isolated, monkeypatch):
    project=store.create_project("bind")
    path=isolated/"model.glb"
    path.write_bytes(glb({"asset":{"version":"2.0"}}))
    asset=store.add_asset(project["id"],path,"model")
    store.update_project(project["id"],{"model":asset})
    job=store.create_job(project["id"],"bind")
    settings=copy.deepcopy(config.DEFAULTS)
    settings["output_dir"]=str(isolated/"outputs")
    monkeypatch.setattr(jobs,"load_settings",lambda:settings)
    async def forbidden(*args,**kwargs):
        raise AssertionError("Blender must not run without a confirmed preview")
    monkeypatch.setattr(processes,"blender",forbidden)
    asyncio.run(jobs.execute_job(job,{"transform":{}}))
    saved=store.get_job(job["id"])
    assert saved["status"]=="failed"
    assert "对齐预览" in saved["message"]


def test_provider_urls_cannot_contain_secrets():
    for url in ("https://example.com/v1?key=abc","file:///secret","https://user:pass@example.com"):
        with pytest.raises(ValueError):
            providers.endpoint(url,"images/generations")


def test_tripo_id_persisted_before_watch(isolated, monkeypatch):
    project=store.create_project("model")
    paths={}
    for label in ("front","left","back"):
        path=isolated/f"{label}.png"
        path.write_bytes(sheet_bytes())
        paths[label]=store.add_asset(project["id"],path,"image")
    store.update_project(project["id"],{"views":paths})
    job=store.create_job(project["id"],"model")
    calls=[]
    async def cli(args,settings,on_json=None):
        calls.append(args)
        if args[0]=="generate":
            return {"task_id":"remote-task-123"}
        assert store.get_job(job["id"])["remote_id"]=="remote-task-123"
        raise RuntimeError("watch interrupted")
    monkeypatch.setattr(processes,"tripo",cli)
    settings=copy.deepcopy(config.DEFAULTS)
    settings["output_dir"]=str(isolated/"outputs")
    settings["tripo"]["mode"]="api"
    monkeypatch.setattr(jobs,"load_settings",lambda:settings)
    asyncio.run(jobs.execute_job(job,{}))
    assert len(calls)==2
    assert store.get_job(job["id"])["status"]=="failed"
    assert store.get_job(job["id"])["remote_id"]=="remote-task-123"


def test_blender_launcher_resolution():
    candidate=processes.blender_executable(config.DEFAULTS["blender"])
    assert candidate.name=="blender.exe"
    assert candidate.is_file()


def test_studio_default_blocks_api_submission(client, monkeypatch):
    project = client.post("/api/projects", json={}).json()
    assert client.get("/api/settings").json()["tripo"]["mode"] == "studio"
    assert client.get("/api/settings").json()["tripo"]["studio_topology"] == "triangle"
    assert client.get("/api/settings").json()["tripo"]["studio_face_limit"] == 15000
    def forbidden(*args, **kwargs):
        raise AssertionError("Studio mode must not launch API tasks")
    monkeypatch.setattr(jobs, "launch", forbidden)
    response = client.post(f"/api/projects/{project['id']}/jobs", json={"kind": "model", "confirmed": True})
    assert response.status_code == 400
    assert "网页会员" in response.json()["detail"]
    assert store.list_jobs(project["id"]) == []


def test_studio_import_ownership_history_and_conflict(client):
    first = client.post("/api/projects", json={"title": "下载所属角色"}).json()
    other = client.post("/api/projects", json={"title": "当前选中角色"}).json()
    route = f"/api/projects/{first['id']}/upload?kind=model&source=studio&expected_model_id="
    model = glb({"asset": {"version": "2.0"}})
    result = client.post(route, files={"file": ("download.glb", model, "model/gltf-binary")})
    assert result.status_code == 200
    asset = result.json()["model"]
    assert not store.get_project(other["id"]).get("model")
    history = store.list_jobs(first["id"])
    assert history[0]["kind"] == "studio_import"
    assert history[0]["result"]["assets"]["model"]["id"] == asset["id"]
    # A download started against an old model must not replace a newer import.
    conflict = client.post(route, files={"file": ("late.glb", model, "model/gltf-binary")})
    assert conflict.status_code == 400
    assert store.get_project(first["id"])["model"]["id"] == asset["id"]
    assert len(store.list_jobs(first["id"])) == 1
    bad = client.post(route + asset["id"], files={"file": ("bad.glb", b"invalid", "model/gltf-binary")})
    assert bad.status_code == 400
    active = store.create_job(first["id"], "align")
    busy = client.post(route + asset["id"], files={"file": ("good.glb", model, "model/gltf-binary")})
    assert busy.status_code == 400
    store.update_job(active["id"], "success")
    retry = client.post(route + asset["id"], files={"file": ("good.glb", model, "model/gltf-binary")})
    assert retry.status_code == 200
