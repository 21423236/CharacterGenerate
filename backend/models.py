"""Validation shared by uploads and model artifact registration."""
import json
import struct
from pathlib import Path


def validate_glb(raw: bytes) -> None:
    if len(raw) < 20 or raw[:4] != b"glTF":
        raise ValueError("请使用自包含 GLB 2.0 模型")
    version, length = struct.unpack_from("<II", raw, 4)
    if version != 2 or length != len(raw):
        raise ValueError("GLB 文件头或长度不正确")
    chunk_length, chunk_type = struct.unpack_from("<II", raw, 12)
    if chunk_type != 0x4E4F534A or chunk_length > len(raw) - 20:
        raise ValueError("GLB 缺少有效 JSON 块")
    try:
        document = json.loads(raw[20:20 + chunk_length].decode("utf-8"))
        if not isinstance(document, dict) or not str(document.get("asset", {}).get("version", "")).startswith("2"):
            raise ValueError()
        for item in document.get("buffers", []) + document.get("images", []):
            uri = item.get("uri")
            if uri and (not isinstance(uri, str) or not uri.startswith("data:")):
                raise ValueError("GLB 引用了外部文件或远程纹理，请先打包为自包含 GLB")
    except (TypeError, AttributeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("GLB JSON 块格式不正确") from exc


def validate_model(path: Path):
    if path.suffix.lower() == ".glb":
        validate_glb(path.read_bytes())
    elif path.suffix.lower() != ".fbx":
        raise ValueError("供应商返回的模型不是 GLB / FBX，请先转换格式")
