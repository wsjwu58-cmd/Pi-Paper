"""模型供应商适配（ModelProvider 协议：estimate/submit/poll/cancel/healthcheck）。"""

from __future__ import annotations

import os
import random
import shutil
import subprocess
import hashlib
import json
import wave
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from ..core.config import settings

_ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets"
_MOCK_PREVIEW_MP4 = _ASSETS_DIR / "mock_preview.mp4"


@dataclass
class GenerationRequest:
    task_id: int
    model_type: str
    model_name: str
    params: dict = field(default_factory=dict)
    output_dir: str = ""


@dataclass
class ProviderJob:
    job_id: str
    status: str = "running"
    result: dict = field(default_factory=dict)
    error_code: Optional[str] = None
    error_message: Optional[str] = None


class ModelProvider(ABC):
    """供应商协议。业务代码不依赖供应商私有字段。"""

    name = "base"

    @abstractmethod
    def generate(self, request: GenerationRequest) -> ProviderJob:
        ...

    def healthcheck(self) -> dict:
        return {"ok": True, "provider": self.name}


def _parse_resolution(resolution: str, default: tuple[int, int] = (1024, 1024)) -> tuple[int, int]:
    try:
        w, h = (int(x) for x in resolution.lower().split("x"))
        return max(64, min(w, 4096)), max(64, min(h, 4096))
    except Exception:
        return default


def _resolve_local_media_path(src: str) -> Path | None:
    """把任务输出 / 素材 URL 映射到本地存储路径。"""
    import re
    from urllib.parse import unquote, urlparse, parse_qs

    if not src:
        return None
    p = Path(src)
    if p.exists():
        return p
    # /api/v1/tasks/{id}/outputs/file/{name}
    m = re.search(r"/tasks/(\d+)/outputs/file/([^/?#]+)", src)
    if m:
        candidate = Path(settings.storage_dir) / m.group(1) / unquote(m.group(2))
        if candidate.exists():
            return candidate
    # /api/v1/assets/file?path=objectKey
    if "/assets/file" in src:
        parsed = urlparse(src if "://" in src else f"http://local{src}")
        key = parse_qs(parsed.query).get("path", [None])[0]
        if key:
            candidate = Path(os.environ.get("VIBEPAPER_ASSET_PATH", r"E:\VibePaperProject\data\assets")) / unquote(key).replace("/", os.sep)
            if candidate.exists():
                return candidate
    return None


def _find_source_image(request: GenerationRequest):
    from PIL import Image, ImageDraw

    src = request.params.get("sourcePath") or request.params.get("sourceUrl")
    if isinstance(src, str):
        local = _resolve_local_media_path(src)
        if local is not None:
            return Image.open(local).convert("RGB")
    # 回退：带主体示意的浅色底图（避免三视图变成三块纯黑）
    w, h = _parse_resolution(str(request.params.get("resolution", "1024x1024")))
    img = Image.new("RGB", (w, h), (236, 238, 244))
    draw = ImageDraw.Draw(img)
    cx, cy = w // 2, h // 2
    draw.ellipse([cx - w // 5, cy - h // 4, cx + w // 5, cy + h // 5], fill=(120, 150, 200), outline=(60, 80, 120), width=3)
    draw.rectangle([cx - w // 8, cy + h // 6, cx + w // 8, cy + h // 3], fill=(90, 110, 150))
    prompt = str(request.params.get("prompt") or "source")[:36]
    draw.text((16, 16), prompt, fill=(40, 40, 50))
    return img


def _normalize_str_list(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if v is not None and str(v).strip()]
    return []


def build_text_user_content(params: dict) -> str:
    """合并提示词与参考栏素材，供文本生成 Provider 使用。"""
    prompt = str(params.get("prompt") or "").strip()
    ref_texts = _normalize_str_list(params.get("referenceTexts"))
    ref_urls = _normalize_str_list(params.get("referenceUrls"))
    sections: list[str] = []
    if ref_texts:
        sections.append("【参考文本】\n" + "\n---\n".join(ref_texts))
    if ref_urls:
        sections.append("【参考素材】\n" + "\n".join(f"- {url}" for url in ref_urls))
    if prompt:
        sections.append("【提示词】\n" + prompt)
    return "\n\n".join(sections) if sections else "请生成一段文本"


def build_generation_prompt(params: dict) -> str:
    """合并提示词与参考文本，供图/音/视频生成使用（参考栏仅有上游文本时也可提交）。"""
    prompt = str(params.get("prompt") or "").strip()
    ref_texts = _normalize_str_list(params.get("referenceTexts"))
    parts: list[str] = []
    if ref_texts:
        parts.extend(ref_texts)
    if prompt:
        parts.append(prompt)
    return "\n".join(parts)


def first_reference_image(params: dict) -> str | None:
    for key in ("image", "imageUrl", "image_url", "referenceUrl", "sourceUrl", "firstFrameUrl"):
        val = params.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    refs = params.get("referenceImages") or params.get("reference_images") or params.get("referenceUrls") or []
    if isinstance(refs, str) and refs.strip():
        return refs.strip()
    if isinstance(refs, (list, tuple)):
        for item in refs:
            if isinstance(item, str) and item.strip():
                return item.strip()
    return None


# 旧方舟 / Mock 别名 → Agnes 正式模型名
IMAGE_MODEL_ALIASES: dict[str, str] = {
    "agnes-image-2.1-flash": "agnes-image-2.5-flash",
    "seedream-4": "agnes-image-2.5-flash",
    "flux-dev": "agnes-image-2.5-flash",
    "sd3-medium": "agnes-image-2.5-flash",
    "doubao-seedream-5-0-260128": "agnes-image-2.5-flash",
    "doubao-seedream-4-0-250828": "agnes-image-2.5-flash",
    "doubao-seedream-4-5-251128": "agnes-image-2.5-flash",
}

VIDEO_MODEL_ALIASES: dict[str, str] = {
    "seedance-1.0": "agnes-video-2.5-flash",
    "seedance-1.5": "agnes-video-2.5-flash",
    "wan-2.1": "agnes-video-2.5-flash",
    "kling-2.0": "agnes-video-2.5-flash",
    "doubao-seedance-1-5-pro-251215": "agnes-video-2.5-flash",
    "doubao-seedance-1-0-pro-250528": "agnes-video-2.5-flash",
    "doubao-seedance-2-0-mini-260615": "agnes-video-2.5-flash",
    "doubao-seedance-2-0-260128": "agnes-video-2.5-flash",
}


def build_agnes_image_payload(params: dict) -> dict:
    """构造 Agnes Image 2.5 Flash 的稳定请求合同。"""
    prompt = build_generation_prompt(params)
    if not prompt:
        raise ValueError("图片生成需要 prompt")
    model = resolve_image_model(str(params.get("model") or "agnes-image-2.5-flash"))
    size, ratio = _agnes_image_size_and_ratio(params)
    body: dict = {"model": model, "prompt": prompt[:2000], "size": size, "ratio": ratio}
    extra_body: dict = {"response_format": "url"}
    images: list[str] = []
    primary = first_reference_image(params)
    if primary:
        images.append(_agnes_image_reference(str(primary)))
    for key in ("referenceImages", "reference_images", "referenceUrls"):
        for item in _normalize_str_list(params.get(key)):
            media = _agnes_image_reference(item)
            if media and media not in images:
                images.append(media)
    if images:
        extra_body["image"] = images
    body["extra_body"] = extra_body
    return body


def build_agnes_video_payload(params: dict) -> dict:
    """构造 Agnes Video 2.5 Flash 请求合同，禁止混入 V2.0 帧数参数。"""
    prompt = build_generation_prompt(params)
    if not prompt:
        raise ValueError("视频生成需要 prompt")
    explicit_size = str(params.get("size") or "").strip().upper()
    if explicit_size and explicit_size != "720P":
        raise ValueError("Agnes Video 2.5 Flash 仅支持 720P")
    raw_seconds = params.get("seconds", params.get("duration", 5))
    try:
        seconds = int(float(raw_seconds))
    except (TypeError, ValueError) as error:
        raise ValueError("视频 seconds 必须是整数") from error
    if seconds < 4 or seconds > 12:
        raise ValueError("视频 seconds 必须在 4 到 12 秒之间")

    first = params.get("firstFrameUrl")
    last = params.get("lastFrameUrl")
    refs = _normalize_str_list(
        params.get("referenceImages")
        or params.get("reference_images")
        or params.get("referenceUrls")
    )
    if len(refs) > 5:
        raise ValueError("Agnes Video 2.5 Flash 最多支持 5 张参考图")

    model = resolve_video_model(str(params.get("model") or "agnes-video-2.5-flash"))
    if isinstance(first, str) and first.strip():
        mode = "keyframe"
        images = [_media_url_for_remote_api(first.strip())]
        if isinstance(last, str) and last.strip():
            images.append(_media_url_for_remote_api(last.strip()))
        extra_body = {"image": images, "mode": "keyframes"}
    elif refs:
        mode = "reference"
        extra_body = {"image": [_media_url_for_remote_api(item) for item in refs], "mode": "reference"}
    else:
        mode = "text"
        extra_body = None

    body: dict = {
        "model": model,
        "mode": mode,
        "prompt": prompt[:2000],
        "size": "720P",
        "seconds": str(seconds),
        "n": 1,
    }
    aspect_ratio = str(params.get("aspect_ratio") or params.get("aspectRatio") or params.get("ratio") or "").strip()
    if aspect_ratio:
        if aspect_ratio not in {"21:9", "16:9", "4:3", "1:1", "3:4", "9:16"}:
            raise ValueError("视频 aspect_ratio 无效")
        body["aspect_ratio"] = aspect_ratio
    if extra_body:
        body["extra_body"] = extra_body
    return body


def build_agnes_video_poll_url(video_id: str, model_name: str) -> str:
    """生成带 model_name 的 Agnes 视频状态查询 URL。"""
    from urllib.parse import urlencode

    return "https://apihub.agnes-ai.com/agnesapi?" + urlencode(
        {"video_id": str(video_id), "model_name": str(model_name)}
    )


def resolve_image_model(model_name: str | None) -> str:
    raw = (model_name or "").strip()
    if raw in IMAGE_MODEL_ALIASES:
        return IMAGE_MODEL_ALIASES[raw]
    if raw.startswith("agnes-image"):
        return raw
    return raw or settings.agnes_image_model or "agnes-image-2.5-flash"


def resolve_video_model(model_name: str | None) -> str:
    raw = (model_name or "").strip()
    if raw in VIDEO_MODEL_ALIASES:
        return VIDEO_MODEL_ALIASES[raw]
    if raw == "agnes-video-v2.0":
        return "agnes-video-2.5-flash"
    if raw.startswith("agnes-video"):
        return raw
    return raw or settings.agnes_video_model or "agnes-video-2.5-flash"


def _agnes_frames_for_duration(seconds: int, fps: int = 24) -> int:
    """Agnes Video：num_frames ≤ 441 且满足 8n+1。"""
    target = max(1, int(seconds) * int(fps))
    n = max(1, round((target - 1) / 8))
    return min(441, 8 * n + 1)


def _httpx_retry_429(request_fn, *, attempts: int = 5, first_delay: float = 3.0):
    """Agnes 创建接口遇限流或临时拥塞时退避重试。

    Agnes 在文本生图队列满时会返回 503（而不是 429）；这属于
    可恢复的供应商瞬态错误，不能直接把本次任务判成模型不可用。
    """
    import time

    delay = first_delay
    last = None
    for _ in range(max(1, attempts)):
        last = request_fn()
        if getattr(last, "status_code", 0) not in {429, 502, 503, 504}:
            return last
        time.sleep(delay)
        delay = min(delay * 2, 30)
    return last


def _agnes_wh_from_params(params: dict) -> tuple[int, int]:
    ratio = str(params.get("ratio") or "").strip()
    resolution = str(params.get("resolution") or "").strip().lower()
    if "x" in resolution:
        try:
            w, h = (int(x) for x in resolution.split("x", 1))
            return max(64, w), max(64, h)
        except Exception:
            pass
    mapping = {
        "16:9": (1152, 768),
        "9:16": (768, 1152),
        "1:1": (768, 768),
        "4:3": (1024, 768),
        "3:4": (768, 1024),
    }
    return mapping.get(ratio, (1152, 768))


def _agnes_image_size_and_ratio(params: dict) -> tuple[str, str]:
    explicit = str(params.get("size") or "").strip().upper()
    ratio = str(params.get("ratio") or params.get("aspectRatio") or "").strip()
    resolution = str(params.get("resolution") or "").strip()
    if not ratio and "x" in resolution.lower():
        try:
            w, h = (int(x) for x in resolution.lower().split("x", 1))
            if w == h:
                ratio = "1:1"
            elif w > h:
                ratio = "16:9" if w / h > 1.4 else "4:3"
            else:
                ratio = "9:16" if h / w > 1.4 else "3:4"
        except Exception:
            ratio = "1:1"
    ratio = ratio or "1:1"
    if ratio not in {"21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "2:3", "3:2"}:
        raise ValueError("图片 ratio 无效")
    if explicit in {"1K", "2K", "3K", "4K"}:
        return explicit, ratio
    mapping = {
        "512x512": "1K",
        "768x768": "1K",
        "1024x1024": "1K",
        "1280x720": "2K",
        "1920x1080": "2K",
        "3840x2160": "4K",
    }
    return mapping.get(resolution, settings.agnes_image_size or "2K"), ratio


def parse_ark_http_error(response) -> tuple[str, str]:
    """解析方舟 HTTP 错误体，返回 (error_code, user_message)。"""
    try:
        payload = response.json()
    except Exception:
        return "MODEL_UNAVAILABLE", f"方舟 API 错误 HTTP {response.status_code}"
    err = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    code = str(err.get("code") or "MODEL_UNAVAILABLE")
    message = str(err.get("message") or payload.get("message") or response.text or "")
    if code == "ModelNotOpen":
        return "MODEL_UNAVAILABLE", (
            f"视频模型未开通（{message}）。请前往火山方舟控制台 → 模型广场，开通对应 Seedance 模型后再试。"
        )
    if code in {"InvalidEndpointOrModel.NotFound", "NotFound"}:
        return "MODEL_UNAVAILABLE", (
            f"视频模型不可用（{message}）。请确认模型 ID 正确，且当前账号已开通该模型。"
        )
    if "AccountOverdue" in code or "overdue" in message.lower() or "欠费" in message:
        return "INSUFFICIENT_POINTS", (
            f"方舟账号欠费或该模型无可用额度（{message[:200]}）。"
            "请确认调用的是已开通且有免费额度的模型（如 Seedance 1.5 Pro），并在控制台结清欠费。"
        )
    if message:
        return code if code else "MODEL_UNAVAILABLE", message[:500]
    return "MODEL_UNAVAILABLE", f"方舟 API 错误 HTTP {response.status_code}"


class MockTextProvider(ModelProvider):
    name = "mock-text"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        content = build_text_user_content(request.params)
        count = int(request.params.get("count", 1))
        results = []
        for i in range(count):
            results.append({
                "text": f"# {request.model_name} 生成结果 {i + 1}\n\n{content}\n\n> VibePaper Mock Provider 输出（用于本地联调）。",
                "meta": {"index": i, "text": f"# {request.model_name} 生成结果 {i + 1}\n\n{content}"},
            })
        return ProviderJob(job_id=f"txt-{request.task_id}", status="succeeded", result={"outputs": results})


_TEXT_MODEL_ALIASES = {
    "deepseek-v4-pro": "agnes-2.5-flash",
    "deepseek-v4-flash": "agnes-2.5-flash",
    "deepseek-chat": "agnes-2.5-flash",
    "qwen-max": "agnes-2.5-flash",
    "gpt-4o-mini": "agnes-2.5-flash",
}


class OpenAICompatibleTextProvider(ModelProvider):
    """OpenAI 兼容文本生成（Agnes Chat Completions）。"""

    name = "openai-text"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        model = request.model_name or settings.llm_model or "agnes-2.5-flash"
        model = _TEXT_MODEL_ALIASES.get(str(model).strip().lower(), model)
        using_agnes = "agnes" in str(model).lower() or "agnes-ai.com" in (
            settings.agnes_base_url or settings.llm_base_url or ""
        )
        if using_agnes:
            api_key = settings.agnes_api_key or settings.llm_api_key or os.getenv("VIBEPAPER_AGNES_API_KEY", "") or os.getenv("VIBEPAPER_LLM_API_KEY", "")
            base = (settings.agnes_base_url or settings.llm_base_url or "https://apihub.agnes-ai.com/v1").rstrip("/")
        else:
            api_key = settings.llm_api_key or os.getenv("VIBEPAPER_LLM_API_KEY", "")
            base = (settings.llm_base_url or "https://apihub.agnes-ai.com/v1").rstrip("/")
        if not api_key:
            # 本地无 Key 才允许 mock；有 Key 时失败必须暴露，禁止静默假成功
            return MockTextProvider().generate(request)
        try:
            import httpx

            user_content = build_text_user_content(request.params)
            if ("agnes-ai.com" in base or "deepseek.com" in base) and not base.endswith("/v1"):
                base = f"{base}/v1"
            resp = httpx.post(
                f"{base}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": "你是 VibePaper 创作助手，输出可直接用于画布的高质量文本。"},
                        {"role": "user", "content": user_content},
                    ],
                    "temperature": 0.7,
                },
                timeout=90,
            )
            resp.raise_for_status()
            text = resp.json()["choices"][0]["message"]["content"]
            return ProviderJob(
                job_id=f"oai-{request.task_id}",
                status="succeeded",
                result={"outputs": [{"text": text, "meta": {"text": text, "provider": self.name}}]},
            )
        except Exception as e:
            return ProviderJob(
                job_id=f"oai-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message=f"文本模型调用失败：{e}"[:500],
            )


class MockImageProvider(ModelProvider):
    name = "mock-image"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        from PIL import Image, ImageDraw, ImageEnhance, ImageOps

        prompt = build_generation_prompt(request.params) or "default"
        operation = str(request.params.get("operation") or "")
        resolution = str(request.params.get("resolution", "1024x1024"))
        count = int(request.params.get("count", 1))
        w, h = _parse_resolution(resolution)
        outputs = []
        for i in range(count):
            if operation in {"裁剪", "扩图", "超分", "三视图", "director"}:
                img = _find_source_image(request)
                if operation == "裁剪":
                    mode = request.params.get("cropMode", "single")
                    cw, ch = img.size
                    if mode == "四宫格":
                        img = img.crop((0, 0, cw // 2, ch // 2))
                    elif mode == "九宫格":
                        img = img.crop((0, 0, cw // 3, ch // 3))
                    else:
                        margin = min(cw, ch) // 8
                        img = img.crop((margin, margin, cw - margin, ch - margin))
                elif operation == "扩图":
                    border = max(32, min(img.size) // 8)
                    img = ImageOps.expand(img, border=border, fill=(24, 24, 32))
                elif operation == "超分":
                    img = img.resize((img.width * 2, img.height * 2), Image.Resampling.LANCZOS)
                    img = ImageEnhance.Sharpness(img).enhance(1.4)
                elif operation == "三视图":
                    category = str(request.params.get("threeViewCategory") or request.params.get("category") or "人物")
                    canvas = Image.new("RGB", (w, h), (245, 246, 250))
                    gap, pad = 10, 12
                    tile_w = (w - pad * 2 - gap * 2) // 3
                    tile_h = h - pad * 2 - 28
                    labels = ["正视", "侧视", "俯视"]
                    for idx, label in enumerate(labels):
                        # 三视角轻微不同变换，避免三块完全一样
                        tile = img.copy()
                        if idx == 1:
                            tile = ImageOps.mirror(tile)
                        elif idx == 2:
                            tile = tile.rotate(90, expand=True, fillcolor=(245, 246, 250))
                        tile = ImageOps.fit(tile, (tile_w, tile_h), method=Image.Resampling.LANCZOS)
                        draw = ImageDraw.Draw(tile)
                        draw.rectangle([0, 0, tile.width - 1, tile.height - 1], outline=(30, 30, 36), width=2)
                        draw.rectangle([0, 0, tile.width, 26], fill=(20, 20, 24))
                        draw.text((8, 6), f"{category}·{label}", fill=(255, 255, 255))
                        canvas.paste(tile, (pad + idx * (tile_w + gap), pad + 24))
                    draw = ImageDraw.Draw(canvas)
                    draw.text((pad, 6), f"三视图 · {category}", fill=(40, 40, 48))
                    img = canvas
                elif operation == "director":
                    canvas = Image.new("RGB", (1280, 720), (24, 24, 36))
                    draw = ImageDraw.Draw(canvas)
                    draw.text((30, 10), "VibePaper Director Stage", fill=(255, 255, 255))
                    for m in request.params.get("models", []) or []:
                        if not isinstance(m, dict):
                            continue
                        x = int(640 + float(m.get("pos", [0, 0])[0]) * 6)
                        y = int(360 + float(m.get("pos", [0, 0])[1]) * 6)
                        color = m.get("color", "#ff5d5d")
                        draw.ellipse([x - 18, y - 18, x + 18, y + 18], outline=color, width=3)
                        draw.text((x - 20, y + 22), str(m.get("name", "model")), fill=color)
                    img = canvas
            else:
                seed = random.randint(0, 2**31)
                img = Image.new("RGB", (w, h))
                pixels = img.load()
                for y in range(h):
                    for x in range(w):
                        pixels[x, y] = (
                            (x * 255 // max(w, 1) + seed % 80) % 256,
                            (y * 255 // max(h, 1) + seed % 130) % 256,
                            ((x + y) * 255 // max(w + h, 1) + seed % 200) % 256,
                        )
                draw = ImageDraw.Draw(img)
                draw.rectangle([0, 0, w - 1, h - 1], outline=(255, 255, 255), width=4)
                draw.text((20, 20), f"VibePaper · {prompt[:40]}", fill=(255, 255, 255))
                draw.text((20, h - 60), f"{request.model_name} · {w}x{h}", fill=(255, 255, 255))
                if request.params.get("style"):
                    draw.text((20, 50), f"style: {request.params.get('style')}", fill=(230, 230, 230))

            out_path = Path(request.output_dir) / f"output_{i}.jpg"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            img = img.convert("RGB")
            img.save(out_path, "JPEG", quality=90)
            outputs.append({
                "url": f"/api/v1/tasks/{request.task_id}/outputs/file/{out_path.name}",
                "file_path": str(out_path),
                "content_type": "image/jpeg",
                "meta": {"index": i, "operation": operation or "generate", "outputType": "image"},
            })
        return ProviderJob(job_id=f"img-{request.task_id}", status="succeeded", result={"outputs": outputs})


def _media_url_for_remote_api(url: str) -> str:
    """外部模型 API 无法拉取 localhost / 内网 URL，本地文件转为 data URL。"""
    from urllib.parse import urlparse

    src = (url or "").strip()
    if not src:
        return src
    if src.startswith("data:"):
        return src
    if src.startswith("http://") or src.startswith("https://"):
        host = (urlparse(src).hostname or "").lower()
        if host not in {"localhost", "127.0.0.1"} and not host.startswith("192.168.") and not host.startswith("10."):
            return src
    local = _resolve_local_media_path(src)
    if local and local.is_file():
        import base64
        import mimetypes

        mime = mimetypes.guess_type(str(local))[0] or "application/octet-stream"
        encoded = base64.b64encode(local.read_bytes()).decode("ascii")
        return f"data:{mime};base64,{encoded}"
    return src


def _agnes_image_reference(value: str) -> str:
    """Return Agnes Image's required raw Base64 representation for local media.

    Agnes Image validates ``extra_body.image`` as a Base64 string.  The generic
    remote-media helper returns a browser-friendly data URI for local canvas
    assets, but its ``data:image/...;base64,`` prefix is not accepted by this
    endpoint.  Strip that prefix here while leaving ordinary public URLs intact
    for existing remote-reference compatibility.
    """
    import base64

    src = (value or "").strip()
    if not src:
        return src
    if src.startswith("data:"):
        header, separator, encoded = src.partition(",")
        if not separator or ";base64" not in header.lower() or not header.lower().startswith("data:image/"):
            raise ValueError("Agnes 图片参考必须是有效的图片 Base64 数据")
        try:
            base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise ValueError("Agnes 图片参考的 Base64 编码无效") from error
        return encoded

    local = _resolve_local_media_path(src)
    if local and local.is_file():
        return base64.b64encode(local.read_bytes()).decode("ascii")
    return src


def _local_reference_image(request: GenerationRequest) -> Path | None:
    ref = first_reference_image(request.params or {})
    if not ref:
        return None
    return _resolve_local_media_path(ref)


def _resolve_ffmpeg() -> str | None:
    configured = (settings.ffmpeg_path or os.environ.get("FFMPEG_PATH") or "").strip()
    if configured:
        p = Path(configured)
        if p.is_file():
            return str(p)

    found = shutil.which("ffmpeg")
    if found:
        return found

    # WinGet 安装的 Gyan.FFmpeg 不一定在服务进程 PATH 中
    if os.name == "nt":
        winget_root = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
        if winget_root.is_dir():
            candidates = sorted(winget_root.glob("Gyan.FFmpeg*/**/bin/ffmpeg.exe"), key=lambda x: x.stat().st_mtime, reverse=True)
            for candidate in candidates:
                if candidate.is_file():
                    return str(candidate)

    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _hex_to_rgb(color: str) -> tuple[int, int, int]:
    c = color.strip().lower()
    if c.startswith("0x"):
        c = c[2:]
    if len(c) == 6:
        return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    return 99, 102, 241


def _is_valid_mp4(path: Path) -> bool:
    try:
        head = path.read_bytes()[:64]
    except OSError:
        return False
    return len(head) >= 8 and b"ftyp" in head[:32]


def _write_mock_mp4(out_path: Path, *, prompt: str, color: str, duration: int = 2) -> None:
    """生成可播放 mock MP4；优先 ffmpeg 合成带文案预览，失败则复制内置样例。"""
    from PIL import Image, ImageDraw

    out_path.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = _resolve_ffmpeg()
    if ffmpeg:
        poster = out_path.with_suffix(".poster.png")
        try:
            img = Image.new("RGB", (1280, 720), _hex_to_rgb(color))
            draw = ImageDraw.Draw(img)
            draw.rectangle([0, 0, 1279, 719], outline=(255, 255, 255), width=4)
            draw.text((40, 40), "VibePaper Mock Video", fill=(255, 255, 255))
            draw.text((40, 90), (prompt or "video preview")[:72], fill=(230, 230, 240))
            draw.text((40, 680), f"{duration}s · mock provider", fill=(200, 200, 210))
            img.save(poster, "PNG")

            cmd = [
                ffmpeg,
                "-y",
                "-loop",
                "1",
                "-framerate",
                "24",
                "-i",
                str(poster),
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency=440:duration={duration}",
                "-t",
                str(duration),
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
                str(out_path),
            ]
            subprocess.run(cmd, check=True, capture_output=True, timeout=120)
            if _is_valid_mp4(out_path):
                return
            out_path.unlink(missing_ok=True)
        except Exception:
            out_path.unlink(missing_ok=True)
        finally:
            poster.unlink(missing_ok=True)

    if _MOCK_PREVIEW_MP4.is_file():
        shutil.copy2(_MOCK_PREVIEW_MP4, out_path)
        if _is_valid_mp4(out_path):
            return
        out_path.unlink(missing_ok=True)

    raise RuntimeError("mock mp4 生成失败：请检查 ffmpeg 或内置样例文件")


def _write_mock_mp4_from_image(out_path: Path, image_path: Path, *, prompt: str, duration: int = 2) -> None:
    """用参考图生成 Mock 图生视频（本地联调）。"""
    from PIL import Image, ImageDraw, ImageOps

    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("图生视频 Mock 需要 ffmpeg（或 imageio-ffmpeg）")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    poster = out_path.with_suffix(".poster.png")
    try:
        img = ImageOps.fit(Image.open(image_path).convert("RGB"), (1280, 720), Image.Resampling.LANCZOS)
        draw = ImageDraw.Draw(img)
        draw.rectangle([0, 0, 1279, 719], outline=(255, 255, 255), width=3)
        if prompt:
            draw.text((32, 32), prompt[:72], fill=(255, 255, 255))
        draw.text((32, 680), "Mock · 参考图预览", fill=(220, 220, 230))
        img.save(poster, "PNG")

        cmd = [
            ffmpeg,
            "-y",
            "-loop",
            "1",
            "-framerate",
            "24",
            "-i",
            str(poster),
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={duration}",
            "-t",
            str(duration),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(out_path),
        ]
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
    finally:
        poster.unlink(missing_ok=True)

    if not _is_valid_mp4(out_path):
        out_path.unlink(missing_ok=True)
        raise RuntimeError("参考图转视频失败")


class MockVideoProvider(ModelProvider):
    name = "mock-video"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        prompt = build_generation_prompt(request.params) or "default"
        operation = str(request.params.get("operation") or "")
        count = int(request.params.get("count", 1))
        camera = str(request.params.get("camera") or "")
        outputs = []
        for i in range(count):
            out_dir = Path(request.output_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            if operation == "提帧":
                # 提帧：输出一张关键帧图片
                from PIL import Image, ImageDraw

                out_path = out_dir / f"frame_{i}.jpg"
                img = Image.new("RGB", (1280, 720), (16, 20, 28))
                draw = ImageDraw.Draw(img)
                draw.text((40, 40), f"Extracted Frame · {prompt[:50]}", fill=(255, 255, 255))
                draw.text((40, 80), f"camera={camera or 'none'}", fill=(200, 200, 200))
                img.save(out_path, "JPEG", quality=90)
                outputs.append({
                    "url": f"/api/v1/tasks/{request.task_id}/outputs/file/{out_path.name}",
                    "file_path": str(out_path),
                    "content_type": "image/jpeg",
                    "meta": {"index": i, "operation": operation, "outputType": "image"},
                })
                continue

            out_path = out_dir / f"output_{i}.mp4"
            color = "0x6366f1"
            if operation == "剪辑":
                color = "0x334155"
            elif operation == "超分":
                color = "0x0f766e"
            elif operation == "compose":
                color = "0x7c3aed"
            ref_image = _local_reference_image(request)
            try:
                if ref_image and ref_image.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
                    _write_mock_mp4_from_image(out_path, ref_image, prompt=prompt, duration=2)
                    used_ref = True
                else:
                    _write_mock_mp4(out_path, prompt=prompt, color=color, duration=2)
                    used_ref = False
            except Exception as exc:
                return ProviderJob(
                    job_id=f"vid-err-{request.task_id}",
                    status="failed",
                    error_code="MODEL_UNAVAILABLE",
                    error_message=f"Mock 视频生成失败：{exc}",
                )
            outputs.append({
                "url": f"/api/v1/tasks/{request.task_id}/outputs/file/{out_path.name}",
                "file_path": str(out_path),
                "content_type": "video/mp4",
                "meta": {
                    "index": i,
                    "operation": operation or "generate",
                    "camera": camera,
                    "outputType": "video",
                    "usedReference": used_ref,
                    "mockProvider": True,
                },
            })
        return ProviderJob(job_id=f"vid-{request.task_id}", status="succeeded", result={"outputs": outputs})


class WindowsSapiTtsProvider(ModelProvider):
    """Development-only offline TTS backed by Windows System.Speech.

    The spoken text and output path are sent over stdin as JSON so neither
    user content nor credentials appear in the process command line.
    """

    name = "local-sapi-tts"
    _MAX_TEXT_LENGTH = 20_000
    _TONE_VOLUME = {"neutral": 100, "calm": 88, "warm": 94, "energetic": 100}

    def normalized_params(self, params: dict) -> dict:
        text = build_generation_prompt(params) or str(params.get("text") or "").strip()
        voice = str(params.get("voice") or "female").strip().lower()
        language = str(params.get("language") or ("zh-CN" if any("\u4e00" <= c <= "\u9fff" for c in text) else "en-US"))
        try:
            speed = float(params.get("speed", 1.0))
        except (TypeError, ValueError):
            speed = 1.0
        speed = max(0.5, min(speed, 2.0))
        # SAPI uses an integer -10..10 rate. Logarithmic mapping keeps the
        # documented 0.5x and 2.0x boundaries symmetric.
        import math

        rate = max(-10, min(10, int(round(math.log2(speed) * 5))))
        tone = str(params.get("tone") or "neutral").strip().lower()
        return {
            "text": text,
            "voice": voice,
            "language": language,
            "rate": rate,
            "volume": self._TONE_VOLUME.get(tone, 100),
            "tone": tone,
            "toneApplied": tone in self._TONE_VOLUME,
            "textHash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        }

    @staticmethod
    def _wave_meta(path: Path) -> tuple[int, int]:
        with wave.open(str(path), "rb") as audio:
            sample_rate = audio.getframerate()
            duration_ms = int(round(audio.getnframes() * 1000 / max(sample_rate, 1)))
        return duration_ms, sample_rate

    def generate(self, request: GenerationRequest) -> ProviderJob:
        normalized = self.normalized_params(request.params)
        text = str(normalized["text"])
        if not text:
            return ProviderJob(
                job_id=f"sapi-empty-{request.task_id}",
                status="failed",
                error_code="INVALID_INPUT",
                error_message="语音合成需要非空文本",
            )
        if len(text) > self._MAX_TEXT_LENGTH:
            return ProviderJob(
                job_id=f"sapi-long-{request.task_id}",
                status="failed",
                error_code="INVALID_INPUT",
                error_message=f"语音合成文本不能超过 {self._MAX_TEXT_LENGTH} 字符",
            )
        if os.name != "nt":
            return ProviderJob(
                job_id=f"sapi-platform-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message="local-sapi-tts 仅支持 Windows 开发环境",
            )

        out_dir = Path(request.output_dir)
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / "tts.wav"
            if out_path.is_file() and out_path.stat().st_size > 44:
                duration_ms, sample_rate = self._wave_meta(out_path)
                selected_voice = str(request.params.get("voiceId") or normalized["voice"])
            else:
                powershell = shutil.which("powershell.exe") or shutil.which("powershell")
                if not powershell:
                    raise RuntimeError("找不到 Windows PowerShell")
                script = r'''
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $culture = New-Object System.Globalization.CultureInfo([string]$payload.language)
  $gender = if ([string]$payload.voice -match 'male|男') {
    [System.Speech.Synthesis.VoiceGender]::Male
  } else {
    [System.Speech.Synthesis.VoiceGender]::Female
  }
  try { $synth.SelectVoiceByHints($gender, [System.Speech.Synthesis.VoiceAge]::Adult, 0, $culture) } catch { }
  $synth.Rate = [int]$payload.rate
  $synth.Volume = [int]$payload.volume
  $synth.SetOutputToWaveFile([string]$payload.outputPath)
  $synth.Speak([string]$payload.text)
  $name = $synth.Voice.Name
  [Console]::Out.Write(($name | ConvertTo-Json -Compress))
} finally {
  $synth.Dispose()
}
'''
                payload = {**normalized, "outputPath": str(out_path)}
                proc = subprocess.run(
                    [powershell, "-NoProfile", "-NonInteractive", "-Command", script],
                    input=json.dumps(payload, ensure_ascii=False),
                    text=True,
                    capture_output=True,
                    timeout=120,
                )
                if proc.returncode != 0:
                    message = (proc.stderr or "Windows SAPI 执行失败").strip().splitlines()[-1]
                    raise RuntimeError(message[:300])
                if not out_path.is_file() or out_path.stat().st_size <= 44:
                    raise RuntimeError("Windows SAPI 未生成有效 WAV")
                duration_ms, sample_rate = self._wave_meta(out_path)
                try:
                    selected_voice = str(json.loads(proc.stdout.strip() or '""'))
                except json.JSONDecodeError:
                    selected_voice = str(normalized["voice"])

            return ProviderJob(
                job_id=f"sapi-{request.task_id}",
                status="succeeded",
                result={
                    "outputs": [{
                        "url": f"/api/v1/tasks/{request.task_id}/outputs/file/{out_path.name}",
                        "file_path": str(out_path),
                        "content_type": "audio/wav",
                        "meta": {
                            "index": 0,
                            "outputType": "audio",
                            "voiceId": selected_voice,
                            "language": normalized["language"],
                            "rate": normalized["rate"],
                            "toneApplied": normalized["toneApplied"],
                            "textHash": normalized["textHash"],
                            "durationMs": duration_ms,
                            "sampleRate": sample_rate,
                            "provider": self.name,
                        },
                    }],
                },
            )
        except subprocess.TimeoutExpired:
            return ProviderJob(
                job_id=f"sapi-timeout-{request.task_id}",
                status="failed",
                error_code="MODEL_TIMEOUT",
                error_message="Windows SAPI 语音合成超时",
            )
        except Exception as error:
            return ProviderJob(
                job_id=f"sapi-error-{request.task_id}",
                status="failed",
                error_code="MEDIA_PROCESSING_FAILED",
                error_message=f"Windows SAPI 语音合成失败：{str(error)[:300]}",
            )


class MockAudioProvider(ModelProvider):
    name = "mock-audio"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        return ProviderJob(
            job_id=f"aud-disabled-{request.task_id}",
            status="failed",
            error_code="MODEL_UNAVAILABLE",
            error_message="本地 Mock 音频已停用，请改用「豆包语音合成」（doubao-tts）",
        )


class DoubaoTtsProvider(ModelProvider):
    """火山语音豆包 TTS（OpenSpeech）。需配置 VIBEPAPER_SPEECH_APP_ID / TOKEN。"""

    name = "doubao-tts"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        import base64
        import uuid

        import httpx

        app_id = (getattr(settings, "speech_app_id", None) or "").strip()
        token = (getattr(settings, "speech_token", None) or "").strip()
        cluster = (getattr(settings, "speech_cluster", None) or "volcano_tts").strip()
        if not app_id or not token:
            return ProviderJob(
                job_id=f"tts-no-cred-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message=(
                    "未配置火山语音凭证（VIBEPAPER_SPEECH_APP_ID / VIBEPAPER_SPEECH_TOKEN）。"
                    "请在火山引擎「语音技术」控制台创建应用后填入 .env。"
                ),
            )

        text = build_generation_prompt(request.params) or str(request.params.get("text") or "").strip()
        if not text:
            return ProviderJob(
                job_id=f"tts-empty-{request.task_id}",
                status="failed",
                error_code="INVALID_INPUT",
                error_message="语音合成需要文本 prompt",
            )

        voice = str(
            request.params.get("voice")
            or request.params.get("voice_type")
            or "zh_female_tianmeixiaoyuan_moon_bigtts"
        )
        speed = float(request.params.get("speed") or 1.0)
        payload = {
            "app": {"appid": app_id, "token": token, "cluster": cluster},
            "user": {"uid": str(request.params.get("user_id") or "vibepaper")},
            "audio": {
                "voice_type": voice,
                "encoding": "mp3",
                "speed_ratio": max(0.5, min(speed, 2.0)),
            },
            "request": {
                "reqid": str(uuid.uuid4()),
                "text": text[:1024],
                "operation": "query",
            },
        }
        headers = {
            "Authorization": f"Bearer;{token}",
            "Content-Type": "application/json",
        }
        try:
            with httpx.Client(timeout=60.0) as client:
                resp = client.post(
                    "https://openspeech.bytedance.com/api/v1/tts",
                    headers=headers,
                    json=payload,
                )
            data = resp.json() if resp.content else {}
            if resp.status_code >= 400 or int(data.get("code") or 0) not in {0, 3000}:
                msg = str(data.get("message") or data.get("msg") or resp.text or f"HTTP {resp.status_code}")
                return ProviderJob(
                    job_id=f"tts-err-{request.task_id}",
                    status="failed",
                    error_code="MODEL_UNAVAILABLE",
                    error_message=f"豆包语音合成失败：{msg[:400]}",
                )
            b64 = data.get("data")
            if not b64:
                return ProviderJob(
                    job_id=f"tts-empty-data-{request.task_id}",
                    status="failed",
                    error_code="MODEL_UNAVAILABLE",
                    error_message="豆包语音合成未返回音频数据",
                )
            out_path = Path(request.output_dir) / "tts.mp3"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(base64.b64decode(b64))
            return ProviderJob(
                job_id=f"tts-{request.task_id}",
                status="succeeded",
                result={
                    "outputs": [{
                        "url": f"/api/v1/tasks/{request.task_id}/outputs/file/{out_path.name}",
                        "file_path": str(out_path),
                        "content_type": "audio/mpeg",
                        "meta": {"index": 0, "outputType": "audio", "voice": voice},
                    }],
                },
            )
        except Exception as e:
            return ProviderJob(
                job_id=f"tts-ex-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message=f"豆包语音合成异常：{e}",
            )


class VolcengineArkImageProvider(ModelProvider):
    """火山方舟 Seedream：POST /images/generations（文生图 / 图生图）。"""

    name = "seedream"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        import httpx

        api_key = settings.ark_api_key
        operation = str(request.params.get("operation") or "")
        # 本地轻量加工仍走 Pillow，避免白白烧云额度
        if operation in {"裁剪", "三视图"}:
            return MockImageProvider().generate(request)
        if not api_key:
            return MockImageProvider().generate(request)

        # 仅官方 Endpoint ID 直传；别名回落到配置的免费额度默认
        if request.model_name and request.model_name.startswith("doubao-seedream"):
            model = request.model_name
        else:
            model = settings.ark_image_model or "doubao-seedream-5-0-260128"
        prompt = build_generation_prompt(request.params)
        if operation in {"扩图", "outpaint_image"}:
            prompt = (prompt or "扩展画面边缘，保持主体完整") + "，outpainting，扩图"
        elif operation in {"超分", "upscale_image"}:
            prompt = (prompt or "提升清晰度与细节") + "，高清超分，保留原构图"
        if request.params.get("style"):
            prompt = f"{prompt}\n风格：{request.params.get('style')}"
        if not prompt:
            return ProviderJob(
                job_id=f"seedream-empty-{request.task_id}",
                status="failed",
                error_code="INVALID_INPUT",
                error_message="图片生成需要 prompt",
            )

        size = self._size({**request.params, "_ark_model": model})
        body: dict = {
            "model": model,
            "prompt": prompt[:600],
            "size": size,
            "watermark": bool(request.params.get("watermark", False)),
            "response_format": "url",
        }
        # 图生图 / 扩图超分：传入参考图 URL
        image = first_reference_image(request.params)
        refs = request.params.get("referenceImages") or request.params.get("reference_images") or []
        if not image and refs:
            image = refs[0]
        if image:
            body["image"] = _media_url_for_remote_api(str(image))
        if operation in {"扩图", "outpaint_image", "超分", "upscale_image"} and not image:
            # 无参考图时仍可文生图，但提示调用方
            pass

        count = max(1, min(int(request.params.get("count", 1)), 4))
        # Seedream 单次默认 1 张；多份则循环调用（比开组图更可控）
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        base = settings.ark_base_url.rstrip("/")
        outputs = []
        try:
            with httpx.Client(timeout=120.0) as client:
                for i in range(count):
                    resp = client.post(f"{base}/images/generations", headers=headers, json=body)
                    resp.raise_for_status()
                    data = resp.json()
                    url = self._extract_image_url(data)
                    if not url:
                        return ProviderJob(
                            job_id=f"seedream-bad-{request.task_id}",
                            status="failed",
                            error_code="MODEL_UNAVAILABLE",
                            error_message=f"Seedream 未返回图片 URL: {data}",
                        )
                    out_path = Path(request.output_dir) / f"seedream_{i}.jpg"
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    if url.startswith("data:"):
                        import base64

                        raw = url.split(",", 1)[-1]
                        out_path.write_bytes(base64.b64decode(raw))
                    else:
                        with client.stream("GET", url, timeout=120.0) as dl:
                            dl.raise_for_status()
                            with out_path.open("wb") as f:
                                for chunk in dl.iter_bytes():
                                    f.write(chunk)
                    outputs.append({
                        "url": f"/api/v1/tasks/{request.task_id}/outputs/file/{out_path.name}",
                        "file_path": str(out_path),
                        "content_type": "image/jpeg",
                        "meta": {
                            "outputType": "image",
                            "provider": self.name,
                            "model": model,
                            "operation": operation or "generate",
                            "remoteUrl": url,
                            "index": i,
                        },
                    })
            return ProviderJob(
                job_id=f"seedream-{request.task_id}",
                status="succeeded",
                result={"outputs": outputs},
            )
        except Exception as e:
            return ProviderJob(
                job_id=f"seedream-err-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message=str(e)[:500],
            )

    @staticmethod
    def _size(params: dict) -> str:
        explicit = str(params.get("size") or "").strip()
        model = str(params.get("_ark_model") or settings.ark_image_model or "")
        # Seedream 5.x：只接受 WIDTHxHEIGHT / 2K / 3K / 4K，且像素数 ≥ 3686400（约 2K）
        if "seedream-5" in model or "seedream_5" in model:
            if explicit.upper() in {"2K", "3K", "4K"}:
                return explicit.upper()
            if "x" in explicit.lower():
                try:
                    w, h = (int(x) for x in explicit.lower().split("x", 1))
                    if w * h >= 3686400:
                        return f"{w}x{h}"
                except Exception:
                    pass
            resolution = str(params.get("resolution") or "")
            mapping = {
                "512x512": "2K",
                "768x768": "2K",
                "1024x1024": "2K",
                "1280x720": "2K",
                "1920x1080": "1920x1080",
                "3840x2160": "4K",
            }
            return mapping.get(resolution, "2K")
        if explicit.upper() in {"1K", "2K", "4K"}:
            return explicit.upper()
        resolution = str(params.get("resolution") or "")
        mapping = {
            "512x512": "1K",
            "768x768": "1K",
            "1024x1024": "1K",
            "1280x720": "2K",
            "1920x1080": "2K",
            "3840x2160": "4K",
        }
        return mapping.get(resolution, settings.ark_image_size or "1K")

    @staticmethod
    def _extract_image_url(payload: dict) -> str | None:
        data = payload.get("data")
        if isinstance(data, list) and data:
            first = data[0]
            if isinstance(first, dict):
                if first.get("url"):
                    return first["url"]
                b64 = first.get("b64_json")
                if b64:
                    return f"data:image/jpeg;base64,{b64}"
        if isinstance(data, dict) and data.get("url"):
            return data["url"]
        if payload.get("url"):
            return payload["url"]
        return None


class VolcengineArkVideoProvider(ModelProvider):
    """火山方舟 Seedance：POST /contents/generations/tasks + 轮询下载。"""

    name = "volcengine-ark"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        import time

        import httpx

        api_key = settings.ark_api_key
        if not api_key:
            return ProviderJob(
                job_id=f"ark-no-key-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message="未配置火山方舟 API Key（VIBEPAPER_ARK_API_KEY），无法调用视频生成",
            )

        base = settings.ark_base_url.rstrip("/")
        model = resolve_video_model(request.model_name)
        prompt = build_generation_prompt(request.params)
        if not prompt:
            return ProviderJob(
                job_id=f"ark-empty-{request.task_id}",
                status="failed",
                error_code="INVALID_INPUT",
                error_message="视频生成需要 prompt",
            )

        resolution = str(request.params.get("resolution") or "")
        ratio_map = {
            "1280x720": "16:9",
            "1920x1080": "16:9",
            "720x1280": "9:16",
            "1080x1920": "9:16",
            "1024x1024": "1:1",
        }
        ratio = str(request.params.get("ratio") or ratio_map.get(resolution, "16:9"))
        duration = int(request.params.get("duration") or settings.ark_video_duration or 5)
        duration = max(2, min(duration, 12))
        text = prompt
        if request.params.get("camera"):
            text = f"{prompt}\n运镜：{request.params.get('camera')}"
        if request.params.get("style"):
            text = f"{text}\n风格：{request.params.get('style')}"

        content: list[dict] = [{"type": "text", "text": text}]
        first = request.params.get("firstFrameUrl")
        last = request.params.get("lastFrameUrl")
        if isinstance(first, str) and first.strip():
            content.append({
                "type": "image_url",
                "image_url": {"url": _media_url_for_remote_api(first.strip())},
                "role": "first_frame",
            })
        if isinstance(last, str) and last.strip():
            content.append({
                "type": "image_url",
                "image_url": {"url": _media_url_for_remote_api(last.strip())},
                "role": "last_frame",
            })
        ref_urls = _normalize_str_list(
            request.params.get("referenceUrls") or request.params.get("referenceImages") or request.params.get("reference_images"),
        )
        skip = {str(first or "").strip(), str(last or "").strip()}
        for url in ref_urls:
            if url in skip:
                continue
            content.append({
                "type": "image_url",
                "image_url": {"url": _media_url_for_remote_api(url)},
                "role": "reference_image",
            })
        single = request.params.get("imageUrl") or request.params.get("image_url") or request.params.get("referenceUrl")
        if single and not any(c.get("type") == "image_url" for c in content):
            content.append({
                "type": "image_url",
                "image_url": {"url": _media_url_for_remote_api(str(single))},
                "role": "reference_image",
            })
        for url in request.params.get("referenceVideos") or request.params.get("reference_videos") or []:
            if url:
                content.append({"type": "video_url", "video_url": {"url": url}, "role": "reference_video"})
        for url in request.params.get("referenceAudios") or request.params.get("reference_audios") or []:
            if url:
                content.append({"type": "audio_url", "audio_url": {"url": url}, "role": "reference_audio"})

        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        body = {
            "model": model,
            "content": content,
            "generate_audio": bool(request.params.get("generate_audio", True)),
            "ratio": ratio,
            "duration": duration,
            "watermark": bool(request.params.get("watermark", False)),
        }

        try:
            with httpx.Client(timeout=60.0) as client:
                create = client.post(f"{base}/contents/generations/tasks", headers=headers, json=body)
                if create.status_code >= 400:
                    err_code, err_msg = parse_ark_http_error(create)
                    return ProviderJob(
                        job_id=f"ark-http-{request.task_id}",
                        status="failed",
                        error_code=err_code,
                        error_message=err_msg,
                    )
                created = create.json()
                ark_id = created.get("id") or created.get("task_id") or (created.get("data") or {}).get("id")
                if not ark_id:
                    return ProviderJob(
                        job_id=f"ark-bad-{request.task_id}",
                        status="failed",
                        error_code="MODEL_UNAVAILABLE",
                        error_message=f"方舟未返回任务 ID: {created}",
                    )

                deadline = time.time() + max(60, settings.ark_poll_timeout_seconds)
                last: dict = {}
                while time.time() < deadline:
                    poll = client.get(f"{base}/contents/generations/tasks/{ark_id}", headers=headers)
                    if poll.status_code >= 400:
                        err_code, err_msg = parse_ark_http_error(poll)
                        return ProviderJob(
                            job_id=str(ark_id),
                            status="failed",
                            error_code=err_code,
                            error_message=err_msg,
                        )
                    last = poll.json()
                    data = last.get("data") if isinstance(last.get("data"), dict) else last
                    status = str((data or {}).get("status") or last.get("status") or "").lower()
                    if status in {"succeeded", "success", "completed", "done"}:
                        video_url = self._extract_video_url(last)
                        if not video_url:
                            return ProviderJob(
                                job_id=str(ark_id),
                                status="failed",
                                error_code="MODEL_UNAVAILABLE",
                                error_message=f"任务成功但无视频 URL: {last}",
                            )
                        out_path = Path(request.output_dir) / "seedance.mp4"
                        out_path.parent.mkdir(parents=True, exist_ok=True)
                        with client.stream("GET", video_url, timeout=180.0) as resp:
                            resp.raise_for_status()
                            with out_path.open("wb") as f:
                                for chunk in resp.iter_bytes():
                                    f.write(chunk)
                        return ProviderJob(
                            job_id=str(ark_id),
                            status="succeeded",
                            result={
                                "outputs": [{
                                    "url": f"/api/v1/tasks/{request.task_id}/outputs/file/{out_path.name}",
                                    "file_path": str(out_path),
                                    "content_type": "video/mp4",
                                    "meta": {
                                        "outputType": "video",
                                        "provider": self.name,
                                        "arkTaskId": ark_id,
                                        "remoteUrl": video_url,
                                    },
                                }]
                            },
                        )
                    if status in {"failed", "error", "cancelled", "canceled"}:
                        return ProviderJob(
                            job_id=str(ark_id),
                            status="failed",
                            error_code="MODEL_UNAVAILABLE",
                            error_message=str(last.get("error") or last.get("message") or last)[:500],
                        )
                    time.sleep(max(2, settings.ark_poll_interval_seconds))
                return ProviderJob(
                    job_id=str(ark_id),
                    status="failed",
                    error_code="MODEL_TIMEOUT",
                    error_message=f"方舟视频任务超时: {last}",
                )
        except httpx.HTTPStatusError as e:
            resp = e.response
            err_code, err_msg = parse_ark_http_error(resp) if resp is not None else ("MODEL_UNAVAILABLE", str(e))
            return ProviderJob(
                job_id=f"ark-err-{request.task_id}",
                status="failed",
                error_code=err_code,
                error_message=err_msg,
            )
        except Exception as e:
            return ProviderJob(
                job_id=f"ark-err-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message=str(e)[:500],
            )

    @staticmethod
    def _extract_video_url(payload: dict) -> str | None:
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        content = data.get("content") if isinstance(data, dict) else None

        def from_video_field(val: object) -> str | None:
            if isinstance(val, str) and val.startswith("http"):
                return val
            if isinstance(val, dict):
                url = val.get("url")
                if isinstance(url, str) and url.startswith("http"):
                    return url
            return None

        # Seedance 成功体：content 为对象 {"video_url": "https://..."}
        if isinstance(content, dict):
            for key in ("video_url", "url", "output_url"):
                found = from_video_field(content.get(key))
                if found:
                    return found
        if isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                found = from_video_field(item.get("video_url"))
                if found:
                    return found
                if item.get("type") == "video_url":
                    found = from_video_field(item.get("url")) or from_video_field(item.get("video_url"))
                    if found:
                        return found
        for key in ("video_url", "url", "output_url"):
            found = from_video_field(data.get(key) if isinstance(data, dict) else None)
            if found:
                return found
        output = data.get("output") if isinstance(data, dict) else None
        if isinstance(output, dict):
            for key in ("video_url", "url"):
                found = from_video_field(output.get(key))
                if found:
                    return found
        return None


class AgnesImageProvider(ModelProvider):
    """Agnes Image：POST /images/generations（文生图 / 图生图 / 多图合成）。"""

    name = "agnes-image"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        import base64

        import httpx

        api_key = (settings.agnes_api_key or "").strip()
        operation = str(request.params.get("operation") or "")
        if operation in {"裁剪", "三视图"}:
            return MockImageProvider().generate(request)
        if not api_key:
            return ProviderJob(
                job_id=f"agnes-img-no-key-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message="未配置 Agnes API Key（VIBEPAPER_AGNES_API_KEY），无法调用图像生成",
            )

        model = resolve_image_model(request.model_name)
        prompt = build_generation_prompt(request.params)
        if operation in {"扩图", "outpaint_image"}:
            prompt = (prompt or "扩展画面边缘，保持主体完整") + "，outpainting，扩图"
        elif operation in {"超分", "upscale_image"}:
            prompt = (prompt or "提升清晰度与细节") + "，高清超分，保留原构图"
        if request.params.get("style"):
            prompt = f"{prompt}\n风格：{request.params.get('style')}"
        if not prompt:
            return ProviderJob(
                job_id=f"agnes-img-empty-{request.task_id}",
                status="failed",
                error_code="INVALID_INPUT",
                error_message="图片生成需要 prompt",
            )

        body = build_agnes_image_payload({**request.params, "model": model, "prompt": prompt})

        count = max(1, min(int(request.params.get("count", 1)), 4))
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        base = settings.agnes_base_url.rstrip("/")
        outputs = []
        try:
            with httpx.Client(timeout=360.0) as client:
                for i in range(count):
                    resp = _httpx_retry_429(
                        lambda: client.post(f"{base}/images/generations", headers=headers, json=body),
                    )
                    if resp.status_code >= 400:
                        return ProviderJob(
                            job_id=f"agnes-img-http-{request.task_id}",
                            status="failed",
                            error_code="MODEL_UNAVAILABLE",
                            error_message=f"Agnes 图像 API 错误 HTTP {resp.status_code}: {resp.text[:400]}",
                        )
                    data = resp.json()
                    url = VolcengineArkImageProvider._extract_image_url(data)
                    if not url:
                        return ProviderJob(
                            job_id=f"agnes-img-bad-{request.task_id}",
                            status="failed",
                            error_code="MODEL_UNAVAILABLE",
                            error_message=f"Agnes 未返回图片 URL: {data}",
                        )
                    out_path = Path(request.output_dir) / f"agnes_{i}.jpg"
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    if url.startswith("data:"):
                        raw = url.split(",", 1)[-1]
                        out_path.write_bytes(base64.b64decode(raw))
                    else:
                        with client.stream("GET", url, timeout=180.0) as dl:
                            dl.raise_for_status()
                            with out_path.open("wb") as f:
                                for chunk in dl.iter_bytes():
                                    f.write(chunk)
                    outputs.append({
                        "url": f"/api/v1/tasks/{request.task_id}/outputs/file/{out_path.name}",
                        "file_path": str(out_path),
                        "content_type": "image/jpeg",
                        "meta": {
                            "outputType": "image",
                            "provider": self.name,
                            "model": model,
                            "operation": operation or "generate",
                            "remoteUrl": url if not url.startswith("data:") else None,
                            "index": i,
                        },
                    })
            return ProviderJob(
                job_id=f"agnes-img-{request.task_id}",
                status="succeeded",
                result={"outputs": outputs},
            )
        except Exception as e:
            return ProviderJob(
                job_id=f"agnes-img-err-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message=str(e)[:500],
            )

    @staticmethod
    def _size_and_ratio(params: dict) -> tuple[str, str]:
        explicit = str(params.get("size") or "").strip()
        ratio = str(params.get("ratio") or "").strip()
        resolution = str(params.get("resolution") or "").strip()
        if not ratio and "x" in resolution.lower():
            try:
                w, h = (int(x) for x in resolution.lower().split("x", 1))
                if w == h:
                    ratio = "1:1"
                elif w > h:
                    ratio = "16:9" if w / h > 1.4 else "4:3"
                else:
                    ratio = "9:16" if h / w > 1.4 else "3:4"
            except Exception:
                ratio = "1:1"
        if not ratio:
            ratio = "1:1"
        if explicit.upper() in {"1K", "2K", "3K", "4K"}:
            return explicit.upper(), ratio
        mapping = {
            "512x512": "1K",
            "768x768": "1K",
            "1024x1024": "1K",
            "1280x720": "2K",
            "1920x1080": "2K",
            "3840x2160": "4K",
        }
        size = mapping.get(resolution, settings.agnes_image_size or "2K")
        return size, ratio


class AgnesVideoProvider(ModelProvider):
    """Agnes Video：POST /videos 创建任务，再按 video_id 轮询下载。"""

    name = "agnes-video"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        import time

        import httpx

        api_key = (settings.agnes_api_key or "").strip()
        if not api_key:
            return ProviderJob(
                job_id=f"agnes-vid-no-key-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message="未配置 Agnes API Key（VIBEPAPER_AGNES_API_KEY），无法调用视频生成",
            )

        model = resolve_video_model(request.model_name)
        prompt = build_generation_prompt(request.params)
        if not prompt:
            return ProviderJob(
                job_id=f"agnes-vid-empty-{request.task_id}",
                status="failed",
                error_code="INVALID_INPUT",
                error_message="视频生成需要 prompt",
            )

        text = prompt
        if request.params.get("camera"):
            text = f"{prompt}\n运镜：{request.params.get('camera')}"
        if request.params.get("style"):
            text = f"{text}\n风格：{request.params.get('style')}"

        body = build_agnes_video_payload({**request.params, "model": model, "prompt": text})

        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        base = settings.agnes_base_url.rstrip("/")

        try:
            with httpx.Client(timeout=60.0) as client:
                create = _httpx_retry_429(
                    lambda: client.post(f"{base}/videos", headers=headers, json=body),
                    attempts=5,
                    first_delay=3.0,
                )
                if create.status_code >= 400:
                    return ProviderJob(
                        job_id=f"agnes-vid-http-{request.task_id}",
                        status="failed",
                        error_code="MODEL_UNAVAILABLE",
                        error_message=f"Agnes 视频创建失败 HTTP {create.status_code}: {create.text[:400]}",
                    )
                created = create.json()
                video_id = created.get("video_id") or created.get("id") or created.get("task_id")
                task_id = created.get("task_id") or created.get("id") or video_id
                if not video_id and not task_id:
                    return ProviderJob(
                        job_id=f"agnes-vid-bad-{request.task_id}",
                        status="failed",
                        error_code="MODEL_UNAVAILABLE",
                        error_message=f"Agnes 未返回 video_id/task_id: {created}",
                    )

                deadline = time.time() + max(60, settings.agnes_poll_timeout_seconds)
                last_payload: dict = {}
                poll_interval = max(5, int(settings.agnes_poll_interval_seconds or 10))
                rate_limit_backoff = poll_interval
                # 创建后先等待再查，避免立刻打满状态查询配额
                time.sleep(poll_interval)
                while time.time() < deadline:
                    if video_id:
                        poll = client.get(build_agnes_video_poll_url(str(video_id), model), headers=headers)
                    else:
                        poll = client.get(f"{base}/videos/{task_id}", headers=headers)
                    if poll.status_code == 429:
                        # Agnes: video status query rate limit exceeded — 退避后继续
                        rate_limit_backoff = min(60, max(rate_limit_backoff * 2, poll_interval * 2))
                        time.sleep(rate_limit_backoff)
                        continue
                    if poll.status_code >= 400:
                        return ProviderJob(
                            job_id=str(video_id or task_id),
                            status="failed",
                            error_code="MODEL_UNAVAILABLE",
                            error_message=f"Agnes 视频轮询失败 HTTP {poll.status_code}: {poll.text[:400]}",
                        )
                    rate_limit_backoff = poll_interval
                    last_payload = poll.json() if poll.content else {}
                    status = str(last_payload.get("status") or "").lower()
                    if status in {"completed", "succeeded", "success", "done"}:
                        video_url = self._extract_video_url(last_payload)
                        if not video_url:
                            return ProviderJob(
                                job_id=str(video_id or task_id),
                                status="failed",
                                error_code="MODEL_UNAVAILABLE",
                                error_message=f"任务成功但无视频 URL: {last_payload}",
                            )
                        out_path = Path(request.output_dir) / "agnes.mp4"
                        out_path.parent.mkdir(parents=True, exist_ok=True)
                        with client.stream("GET", video_url, timeout=180.0) as resp:
                            resp.raise_for_status()
                            with out_path.open("wb") as f:
                                for chunk in resp.iter_bytes():
                                    f.write(chunk)
                        return ProviderJob(
                            job_id=str(video_id or task_id),
                            status="succeeded",
                            result={
                                "outputs": [{
                                    "url": f"/api/v1/tasks/{request.task_id}/outputs/file/{out_path.name}",
                                    "file_path": str(out_path),
                                    "content_type": "video/mp4",
                                    "meta": {
                                        "outputType": "video",
                                        "provider": self.name,
                                        "model": model,
                                        "agnesVideoId": video_id,
                                        "agnesTaskId": task_id,
                                        "remoteUrl": video_url,
                                        "seconds": last_payload.get("seconds"),
                                        "size": last_payload.get("size"),
                                    },
                                }],
                            },
                        )
                    if status in {"failed", "error", "cancelled", "canceled"}:
                        err = last_payload.get("error") or last_payload.get("message") or last_payload
                        return ProviderJob(
                            job_id=str(video_id or task_id),
                            status="failed",
                            error_code="MODEL_UNAVAILABLE",
                            error_message=str(err)[:500],
                        )
                    time.sleep(poll_interval)
                return ProviderJob(
                    job_id=str(video_id or task_id),
                    status="failed",
                    error_code="MODEL_TIMEOUT",
                    error_message=f"Agnes 视频任务超时: {last_payload}",
                )
        except Exception as e:
            return ProviderJob(
                job_id=f"agnes-vid-err-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message=str(e)[:500],
            )

    @staticmethod
    def _extract_video_url(payload: dict) -> str | None:
        meta = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        for key in ("url", "video_url", "output_url"):
            val = meta.get(key) if meta else None
            if isinstance(val, str) and val.startswith("http"):
                return val
        for key in ("url", "video_url", "output_url"):
            val = payload.get(key)
            if isinstance(val, str) and val.startswith("http"):
                return val
        return VolcengineArkVideoProvider._extract_video_url(payload)


class ComfyUIProvider(ModelProvider):
    """ComfyUI 适配占位：仅当配置 VIBEPAPER_COMFYUI_BASE_URL 时启用，否则不可用。"""

    name = "comfyui"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        if not settings.comfyui_base_url:
            return ProviderJob(
                job_id=f"comfy-off-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message="ComfyUI 未接入：请配置 VIBEPAPER_COMFYUI_BASE_URL 并启动 ComfyUI",
            )
        # 最小探测：/system_stats；完整工作流提交后续按 workflow 注册表扩展
        try:
            import httpx

            base = settings.comfyui_base_url.rstrip("/")
            r = httpx.get(f"{base}/system_stats", timeout=10)
            if r.status_code != 200:
                raise RuntimeError(f"ComfyUI 不可用: HTTP {r.status_code}")
            return ProviderJob(
                job_id=f"comfy-stub-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message="ComfyUI 已连通，但 workflow 提交尚未实现（仅探测在线）",
            )
        except Exception as e:
            return ProviderJob(
                job_id=f"comfy-err-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message=str(e)[:300],
            )


class ComposeProvider(ModelProvider):
    """多段视频按顺序拼接（FFmpeg concat）。"""

    name = "mock-compose"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        import httpx

        urls = _normalize_str_list(request.params.get("inputUrls") or request.params.get("inputs"))
        if len(urls) < 2:
            return ProviderJob(
                job_id=f"compose-bad-{request.task_id}",
                status="failed",
                error_code="INVALID_INPUT",
                error_message="合成至少需要 2 段视频输入",
            )

        ffmpeg = _resolve_ffmpeg()
        if not ffmpeg:
            return ProviderJob(
                job_id=f"compose-ff-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message="合成需要 ffmpeg，请安装后重试",
            )

        out_dir = Path(request.output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        work = out_dir / "_compose_inputs"
        work.mkdir(parents=True, exist_ok=True)

        local_paths: list[Path] = []
        try:
            with httpx.Client(timeout=120.0, follow_redirects=True) as client:
                for i, url in enumerate(urls):
                    local = _resolve_local_media_path(url)
                    if local and local.is_file():
                        local_paths.append(local)
                        continue
                    if url.startswith("data:"):
                        import base64

                        header, _, b64 = url.partition(",")
                        ext = ".mp4"
                        if "webm" in header:
                            ext = ".webm"
                        dest = work / f"input_{i}{ext}"
                        dest.write_bytes(base64.b64decode(b64))
                        local_paths.append(dest)
                        continue
                    if url.startswith("http://") or url.startswith("https://"):
                        dest = work / f"input_{i}.mp4"
                        with client.stream("GET", url) as resp:
                            resp.raise_for_status()
                            with dest.open("wb") as f:
                                for chunk in resp.iter_bytes():
                                    f.write(chunk)
                        local_paths.append(dest)
                        continue
                    return ProviderJob(
                        job_id=f"compose-miss-{request.task_id}",
                        status="failed",
                        error_code="INVALID_INPUT",
                        error_message=f"无法读取第 {i + 1} 段视频：{url[:120]}",
                    )

            if len(local_paths) < 2:
                return ProviderJob(
                    job_id=f"compose-few-{request.task_id}",
                    status="failed",
                    error_code="INVALID_INPUT",
                    error_message="有效视频不足 2 段，无法合成",
                )

            out_path = out_dir / "compose.mp4"
            # 统一重编码再拼接，避免编码/分辨率不一致导致 concat 失败
            normalized: list[Path] = []
            for i, src in enumerate(local_paths):
                norm = work / f"norm_{i}.mp4"
                cmd = [
                    ffmpeg,
                    "-y",
                    "-i",
                    str(src),
                    "-vf",
                    "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=24",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-ar",
                    "44100",
                    "-ac",
                    "2",
                    "-shortest",
                    str(norm),
                ]
                proc = subprocess.run(cmd, capture_output=True, timeout=180)
                if proc.returncode != 0 or not _is_valid_mp4(norm):
                    err = (proc.stderr or b"").decode("utf-8", errors="ignore")[-400:]
                    return ProviderJob(
                        job_id=f"compose-norm-{request.task_id}",
                        status="failed",
                        error_code="MODEL_UNAVAILABLE",
                        error_message=f"第 {i + 1} 段视频转码失败：{err or 'unknown'}",
                    )
                normalized.append(norm)

            list_file = work / "concat.txt"
            list_file.write_text(
                "".join(f"file '{p.resolve().as_posix()}'\n" for p in normalized),
                encoding="utf-8",
            )
            concat_cmd = [
                ffmpeg,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_file),
                "-c",
                "copy",
                str(out_path),
            ]
            proc = subprocess.run(concat_cmd, capture_output=True, timeout=180)
            if proc.returncode != 0 or not _is_valid_mp4(out_path):
                # copy 失败时再尝试重编码拼接
                concat_cmd = [
                    ffmpeg,
                    "-y",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    str(list_file),
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    str(out_path),
                ]
                proc = subprocess.run(concat_cmd, capture_output=True, timeout=240)
                if proc.returncode != 0 or not _is_valid_mp4(out_path):
                    err = (proc.stderr or b"").decode("utf-8", errors="ignore")[-400:]
                    return ProviderJob(
                        job_id=f"compose-cat-{request.task_id}",
                        status="failed",
                        error_code="MODEL_UNAVAILABLE",
                        error_message=f"视频拼接失败：{err or 'unknown'}",
                    )

            return ProviderJob(
                job_id=f"compose-{request.task_id}",
                status="succeeded",
                result={
                    "outputs": [
                        {
                            "url": f"/api/v1/tasks/{request.task_id}/outputs/file/{out_path.name}",
                            "file_path": str(out_path),
                            "content_type": "video/mp4",
                            "meta": {
                                "outputType": "video",
                                "operation": "compose",
                                "inputCount": len(normalized),
                                "provider": self.name,
                            },
                        }
                    ]
                },
            )
        except Exception as e:
            return ProviderJob(
                job_id=f"compose-err-{request.task_id}",
                status="failed",
                error_code="MODEL_UNAVAILABLE",
                error_message=str(e)[:500],
            )


class MockComposeProvider(ComposeProvider):
    """兼容旧注册名。"""

    name = "mock-compose"


class MockDirectorProvider(MockImageProvider):
    name = "mock-director"

    def generate(self, request: GenerationRequest) -> ProviderJob:
        params = dict(request.params)
        params["operation"] = "director"
        return super().generate(GenerationRequest(
            task_id=request.task_id,
            model_type=request.model_type,
            model_name=request.model_name,
            params=params,
            output_dir=request.output_dir,
        ))


_openai_text = OpenAICompatibleTextProvider()

PROVIDER_REGISTRY: dict[str, ModelProvider] = {
    "mock": MockTextProvider(),
    "mock-text": MockTextProvider(),
    "mock-image": MockImageProvider(),
    "mock-video": MockVideoProvider(),
    "mock-audio": MockAudioProvider(),
    "local-sapi-tts": WindowsSapiTtsProvider(),
    "doubao-tts": DoubaoTtsProvider(),
    "mock-compose": ComposeProvider(),
    "mock-director": MockDirectorProvider(),
    "openai": _openai_text,
    "openai-text": _openai_text,
    "agnes-text": _openai_text,
    "deepseek": _openai_text,
    "qwen": _openai_text,
    "agnes": AgnesImageProvider(),
    "agnes-image": AgnesImageProvider(),
    "agnes-video": AgnesVideoProvider(),
    # 旧方舟 provider 名保留，默认路由到 Agnes
    "seedream": AgnesImageProvider(),
    "volcengine-ark-image": AgnesImageProvider(),
    "volcengine-ark": AgnesVideoProvider(),
    "seedance": AgnesVideoProvider(),
    "comfyui": ComfyUIProvider(),
}


def get_provider(provider_name: str, model_type: str | None = None) -> ModelProvider:
    modality = (model_type or "").lower()
    pname = (provider_name or "").lower()

    if pname == "local-sapi-tts":
        return PROVIDER_REGISTRY["local-sapi-tts"]

    if "agnes-video" in pname or pname == "agnes-video":
        return PROVIDER_REGISTRY["agnes-video"]
    # Agnes 文本必须先于图像路由，否则 agnes-2.5-flash 会被当成图
    if (
        pname in {"agnes-text", "openai-text", "openai", "deepseek", "qwen"}
        or modality in {"text"}
        or "agnes-2.5" in pname
        or "agnes-2.5" in modality
    ):
        return PROVIDER_REGISTRY["openai-text"]
    if "agnes" in pname or "agnes" in modality:
        if modality in {"video"} or "video" in pname:
            return PROVIDER_REGISTRY["agnes-video"]
        return PROVIDER_REGISTRY["agnes-image"]

    # 旧方舟命名统一走 Agnes
    if "seedream" in pname or "seedream" in modality:
        return PROVIDER_REGISTRY["agnes-image"]
    if "seedance" in pname or "seedance" in modality:
        return PROVIDER_REGISTRY["agnes-video"]

    if pname in PROVIDER_REGISTRY and pname != "mock":
        if pname == "volcengine-ark" and (
            modality in {"image"} or modality.startswith("flux") or modality.startswith("seedream") or modality.startswith("agnes-image")
        ):
            return PROVIDER_REGISTRY["agnes-image"]
        return PROVIDER_REGISTRY[pname]

    if modality in {"compose"} or "compose" in modality:
        return PROVIDER_REGISTRY["mock-compose"]
    if modality in {"director"} or "director" in modality:
        return PROVIDER_REGISTRY["mock-director"]
    if modality in {"image"} or modality.startswith("flux") or modality.startswith("sd") or modality.startswith("agnes-image"):
        if settings.agnes_api_key:
            return PROVIDER_REGISTRY["agnes-image"]
        return PROVIDER_REGISTRY["mock-image"]
    if modality in {"video"} or modality.startswith("wan") or modality.startswith("kling") or modality.startswith("agnes-video"):
        if pname == "mock-video":
            return PROVIDER_REGISTRY["mock-video"]
        return PROVIDER_REGISTRY["agnes-video"]
    if modality in {"audio"} or modality.startswith("music") or modality.startswith("audio") or "tts" in pname:
        if pname in {"doubao-tts", "mock-audio"}:
            return PROVIDER_REGISTRY.get(pname) or PROVIDER_REGISTRY["doubao-tts"]
        return PROVIDER_REGISTRY["doubao-tts"]
    if pname in {"openai", "openai-text", "agnes-text", "deepseek", "qwen"} or modality in {"text"}:
        return PROVIDER_REGISTRY["openai-text"]
    if pname == "comfyui":
        return PROVIDER_REGISTRY["comfyui"]
    return PROVIDER_REGISTRY["mock-text"]
