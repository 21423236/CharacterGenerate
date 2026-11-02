from __future__ import annotations

import io
import warnings
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 36_000_000
MAX_IMAGE_BYTES = 25 * 1024 * 1024


def decode_image(data: bytes) -> Image.Image:
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片不能超过 25 MB")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        try:
            image = Image.open(io.BytesIO(data))
            if image.format not in ("PNG", "JPEG", "WEBP"):
                raise ValueError("仅支持 PNG、JPEG、WebP 图片")
            image.load()
            return ImageOps.exif_transpose(image).convert("RGBA")
        except (OSError, Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
            raise ValueError("无法读取图片，或图片分辨率过大") from exc


def foreground_mask(image: Image.Image) -> np.ndarray:
    rgba = np.asarray(image.convert("RGBA"))
    if np.any(rgba[:, :, 3] < 240):
        return rgba[:, :, 3] > 32
    rgb = rgba[:, :, :3].astype(np.int16)
    border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]))
    background = np.median(border, axis=0)
    return np.max(np.abs(rgb - background), axis=2) > 30


def suggest_boxes(image: Image.Image) -> list[list[float]]:
    small = image.copy()
    small.thumbnail((1200, 800))
    activity = foreground_mask(small).mean(axis=0)
    width = small.width
    cuts = [0]
    for fraction in (1 / 3, 2 / 3):
        start, end = int(width * (fraction - .12)), int(width * (fraction + .12))
        # Prefer an actual empty gutter, but don't pretend a guessed split is authoritative.
        scores = activity[start:end] + .025 * np.abs(np.arange(start, end) / width - fraction)
        cuts.append(int(start + np.argmin(scores)))
    cuts.append(width)
    return [[cuts[i] / width, 0, cuts[i + 1] / width, 1] for i in range(3)]


def split_views(image: Image.Image, boxes: list[list[float]], labels: list[str], destination: Path):
    if len(boxes) != 3 or set(labels) not in ({"front", "left", "back"}, {"front", "right", "back"}):
        raise ValueError("必须指定正面、一个侧面和背面，且标签不能重复")
    crops, bounds, notes = [], [], []
    for box in boxes:
        if len(box) != 4 or not all(np.isfinite(v) for v in box):
            raise ValueError("裁切框格式不正确")
        x0, y0, x1, y1 = box
        if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
            raise ValueError("裁切框必须在图片内，且宽高大于零")
        crop = image.crop((round(x0 * image.width), round(y0 * image.height), round(x1 * image.width), round(y1 * image.height)))
        if min(crop.size) < 64:
            raise ValueError("裁切后的图片过小，至少需要 64 像素")
        mask = foreground_mask(crop)
        ys, xs = np.where(mask)
        bound = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1) if len(xs) else (0, 0, crop.width, crop.height)
        if not len(xs):
            notes.append("未识别到清晰主体，请检查图片和裁切框")
        if bound[0] < 2 or bound[1] < 2 or bound[2] > crop.width - 2 or bound[3] > crop.height - 2:
            notes.append("主体接近裁切边缘，请确认头顶、双手和脚部没有截断")
        crops.append(crop)
        bounds.append(bound)
    heights = [b[3] - b[1] for b in bounds]
    if max(heights) / max(1, min(heights)) > 1.15:
        notes.append("不同视图主体高度差超过 15%，请确认比例一致；工具不会单独拉伸身体")
    # One uniform scale for all three views preserves their relative proportions.
    factor = min(900 / max(heights), 900 / max(b[2] - b[0] for b in bounds))
    destination.mkdir(parents=True, exist_ok=True)
    paths = {}
    for crop, bound, label in zip(crops, bounds, labels):
        subject = crop.crop(bound)
        subject = subject.resize((max(1, round(subject.width * factor)), max(1, round(subject.height * factor))), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (1024, 1024), "white")
        canvas.alpha_composite(subject, ((1024 - subject.width) // 2, 962 - subject.height))
        path = destination / f"{label}.png"
        canvas.convert("RGB").save(path)
        paths[label] = path
    return paths, list(dict.fromkeys(notes))
