from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path

from .config import ROOT, redact

CLI = ROOT / "node_modules" / "tripo-cli" / "dist" / "cli.js"


def blender_executable(config):
    path = Path(config["executable"].strip().strip('"'))
    if path.name.lower() == "blender-launcher.exe":
        path = path.with_name("blender.exe")
    if not path.is_file() or path.name.lower() not in ("blender.exe", "blender"):
        raise ValueError("请指定有效的 Blender 程序；launcher 同目录需要存在 blender.exe")
    return path.resolve()


def template_path(config):
    path = Path(config["template"].strip().strip('"'))
    if not path.is_file() or path.suffix.lower() != ".blend":
        raise ValueError("请指定存在的 .blend 骨架模板")
    return path.resolve()


async def run_process(args, *, env=None, timeout=1800, on_json=None):
    process = await asyncio.create_subprocess_exec(*map(str, args), stdout=asyncio.subprocess.PIPE,
                                                  stderr=asyncio.subprocess.PIPE, env=env, cwd=ROOT,
                                                  limit=4 * 1024 * 1024,
                                                  creationflags=0x08000000 if os.name == "nt" else 0)
    events, errors = [], bytearray()

    async def stdout():
        while line := await process.stdout.readline():
            text = line.decode("utf-8", errors="replace").strip()
            try:
                event = json.loads(text)
                if isinstance(event, dict):
                    events.append(event)
                    if on_json:
                        on_json(event)
                    if len(events) > 200:
                        del events[:100]
            except json.JSONDecodeError:
                pass

    async def stderr():
        while chunk := await process.stderr.read(4096):
            errors.extend(chunk)
            if len(errors) > 20000:
                del errors[:-16000]

    try:
        async with asyncio.timeout(timeout):
            await asyncio.gather(stdout(), stderr(), process.wait())
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
            await process.wait()
        raise RuntimeError("本地进程已中断或超时。云端任务可能仍在运行，请使用已保存的任务 ID 恢复，不要重新提交。")
    if process.returncode:
        message = redact(errors.decode("utf-8", errors="replace"))
        if not message and events and isinstance(events[-1].get("checks"), list):
            message = redact("\n".join(f"{item.get('name')}: {item.get('detail')}" for item in events[-1]["checks"] if not item.get("ok")))
        raise RuntimeError(message or f"进程退出码 {process.returncode}")
    return events[-1] if events else {}


async def tripo(args, settings, on_json=None):
    node = shutil.which("node")
    if not node or not CLI.is_file():
        raise ValueError("未找到本地 Tripo CLI，请先运行 install.cmd")
    env = os.environ.copy()
    env["TRIPO_REGION"] = settings["tripo"]["region"]
    env["TRIPO_ANALYTICS_ENABLED"] = "0"
    env["NO_COLOR"] = "1"
    if settings["tripo"].get("api_key"):
        env["TRIPO_API_KEY"] = settings["tripo"]["api_key"]
    return await run_process([node, CLI, *args, "--json", "--yes", "--no-open"], env=env, timeout=2100, on_json=on_json)


async def blender(request, destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    req = destination / "blender_request.json"
    report = destination / "blender_report.json"
    req.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
    config = request["config"]
    # The worker is trusted source code; embedded .blend scripts are disabled.
    try:
        await run_process([blender_executable(config), "--background", "--factory-startup", "--disable-autoexec",
                           template_path(config), "--python-exit-code", "1", "--python", ROOT / "backend" / "blender_worker.py", "--", req, report], timeout=1800)
    except RuntimeError:
        if not report.exists():
            raise
    if not report.exists():
        raise RuntimeError("Blender 没有返回报告")
    data = json.loads(report.read_text(encoding="utf-8"))
    if not data.get("ok"):
        raise ValueError(data.get("error", "Blender 处理失败"))
    return data["result"]
