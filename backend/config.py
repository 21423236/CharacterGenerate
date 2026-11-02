from __future__ import annotations

import copy
import ctypes
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("CHARACTER_FORGE_PORT", "8765"))
DATA = Path(os.environ.get("CHARACTER_FORGE_DATA", ROOT / "data")).resolve()
DATA.mkdir(parents=True, exist_ok=True)
CONFIG_FILE = DATA / "settings.json"
DEFAULTS = {
    "llm": {"base_url": "https://api.openai.com/v1", "model": "", "api_key": "", "vision": False},
    "image": {"base_url": "https://api.openai.com/v1", "model": "", "api_key": "", "size": "1536x1024", "response_format": "auto"},
    "tripo": {"mode": "studio", "region": "cn", "api_key": "", "model": "tripo-v3.1", "face_limit": 50000,
              "studio_topology": "triangle", "studio_face_limit": 15000},
    "blender": {
        "executable": r"C:\Program Files\Blender Foundation\Blender 5.2\blender-launcher.exe",
        "template": r"D:\独立游戏\Client\Role1\骨骼和身体.blend",
        "armature": "_COM", "body": "Mesh_Skin_Body", "head": "Mesh_Skin_Head",
        "influences": 4,
    },
    "output_dir": str(DATA / "outputs"),
}


class Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _dpapi(data: bytes, decrypt: bool = False) -> bytes:
    if os.name != "nt":
        raise RuntimeError("本版本密钥持久化需要 Windows DPAPI；其他系统请使用环境变量。")
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    dest = Blob()
    crypt = ctypes.windll.crypt32
    if decrypt:
        ok = crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(dest))
    else:
        ok = crypt.CryptProtectData(ctypes.byref(source), "CharacterForge", None, None, None, 1, ctypes.byref(dest))
    if not ok:
        raise OSError("无法使用 Windows 用户凭据加密/解密密钥")
    try:
        return ctypes.string_at(dest.pbData, dest.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(dest.pbData)


def load_settings(public: bool = False) -> dict:
    settings = copy.deepcopy(DEFAULTS)
    if CONFIG_FILE.exists():
        stored = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        for key, value in stored.items():
            if key in settings and isinstance(value, dict):
                settings[key].update(value)
            elif key in settings:
                settings[key] = value
    for section in ("llm", "image", "tripo"):
        encoded = settings[section].pop("encrypted_key", "")
        if encoded:
            import base64
            settings[section]["api_key"] = _dpapi(base64.b64decode(encoded), True).decode()
        env_key = os.environ.get(f"CHARACTER_FORGE_{section.upper()}_KEY")
        if env_key:
            settings[section]["api_key"] = env_key
        if public:
            settings[section]["has_key"] = bool(settings[section].pop("api_key", ""))
    return settings


def save_settings(patch: dict) -> dict:
    import base64
    settings = load_settings()
    for key, value in patch.items():
        if key not in DEFAULTS:
            continue
        if isinstance(DEFAULTS[key], dict) and isinstance(value, dict):
            for field, new_value in value.items():
                if field not in DEFAULTS[key]:
                    continue
                # An empty password field means keep the existing credential.
                if field == "api_key" and not new_value:
                    continue
                settings[key][field] = new_value
        elif not isinstance(DEFAULTS[key], dict):
            settings[key] = value
    for section in ("llm", "image", "tripo"):
        key = settings[section].pop("api_key", "")
        if key:
            settings[section]["encrypted_key"] = base64.b64encode(_dpapi(key.encode())).decode()
    temporary = CONFIG_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(CONFIG_FILE)
    return load_settings(public=True)


def redact(text: str) -> str:
    import re
    for section in ("llm", "image", "tripo"):
        key = load_settings()[section].get("api_key")
        if key:
            text = text.replace(key, "[REDACTED]")
    text = re.sub(r"(?i)bearer\s+\S+", "Bearer [REDACTED]", text)
    # Signed artifact URLs and credentials should not be persisted in error logs.
    return re.sub(r"(https?://[^\s?]+)\?[^\s]+", r"\1?[REDACTED]", text)[:6000]
