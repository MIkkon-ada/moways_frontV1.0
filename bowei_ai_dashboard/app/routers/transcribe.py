"""Audio transcription via Dashscope Paraformer."""

from __future__ import annotations

import asyncio
import os
import tempfile

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File

from ..llm_config import get_provider_config
from ..permissions import get_current_user_name

router = APIRouter(prefix="/api/transcribe", tags=["transcribe"])

_SUPPORTED_FORMATS = {
    ".mp3", ".mp4", ".wav", ".flac", ".aac", ".ogg",
    ".m4a", ".wma", ".amr", ".webm",
}


def _detect_format(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    fmt_map = {
        ".mp3": "mp3", ".wav": "wav", ".flac": "flac",
        ".aac": "aac", ".ogg": "ogg-opus", ".m4a": "m4a",
        ".wma": "wma", ".amr": "amr", ".webm": "opus",
        ".mp4": "mp4",
    }
    return fmt_map.get(ext, "mp3")


def _do_transcribe(file_bytes: bytes, filename: str, api_key: str) -> str:
    from dashscope.audio.asr import Recognition  # noqa: PLC0415
    import dashscope

    dashscope.api_key = api_key

    suffix = os.path.splitext(filename)[1].lower() or ".mp3"
    fmt = _detect_format(filename)

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    try:
        recognition = Recognition(
            model="paraformer-realtime-v2",
            format=fmt,
            sample_rate=16000,
            language_hints=["zh", "en"],
            api_key=api_key,
            callback=None,
        )
        result = recognition.call(tmp_path)

        if result.status_code != 200:
            raise RuntimeError(f"转写失败（{result.status_code}）: {result.message}")

        output = result.output or {}
        sentences = output.get("sentence") or []
        if sentences:
            text = "".join(s.get("text", "") for s in sentences if s.get("text"))
            return text  # 可能是空字符串（静音），正常返回
        text = output.get("text", "")
        return text  # 空字符串表示静音，交给前端处理
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@router.post("")
async def transcribe(
    file: UploadFile = File(...),
    current_user: str = Depends(get_current_user_name),
):
    filename = file.filename or "audio.mp3"
    ext = os.path.splitext(filename)[1].lower()
    if ext and ext not in _SUPPORTED_FORMATS:
        raise HTTPException(422, f"不支持的音频格式: {ext}")

    api_key = get_provider_config("dashscope").get("api_key", "")
    if not api_key:
        raise HTTPException(500, "未配置 Dashscope API Key，请在系统设置中填写")

    content = await file.read()
    if len(content) > 200 * 1024 * 1024:  # 200 MB limit
        raise HTTPException(413, "文件过大，最大支持 200MB")

    try:
        text = await asyncio.to_thread(_do_transcribe, content, filename, api_key)
        return {"text": text, "filename": filename}
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}")
