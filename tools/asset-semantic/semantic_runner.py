#!/usr/bin/env python3
"""Bounded JSONL sidecar for optional local asset semantics.

The model supply chain is intentionally duplicated here instead of accepting
repository metadata from a caller.  Downloads are opt-in, pinned to immutable
commits and verified before the Node host atomically installs them.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import sys
import time
from typing import Any


MAX_REQUEST_BYTES = 64 * 1024
MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_IMAGE_EDGE = 16_384
MAX_EMBEDDING_TEXT_CHARS = 8_192
MAX_CAPTION_CHARS = 512
MAX_OCR_CHARS = 8_192
MAX_OCR_LINES = 16
PROTOCOL_VERSION = 1
WEIGHT_RANGE_BYTES = 4 * 1024 * 1024
WEIGHT_DOWNLOAD_WORKERS = 4
WEIGHT_DOWNLOAD_ATTEMPTS = 6
DOWNLOAD_OWNER_MARKER = ".t8-semantic-download-owner.json"

MODEL_SPECS: dict[str, dict[str, Any]] = {
    "caption-blip-base": {
        "task": "caption",
        "repository": "Salesforce/blip-image-captioning-base",
        "revision": "82a37760796d32b1411fe092ab5d4e227313294b",
        "download_bytes": 990_769_234,
        "weight": {
            "filename": "pytorch_model.bin",
            "size": 989_820_849,
            "sha256": "d6638651a5526cc2ede56f2b5104d6851b0755816d220e5e046870430180c767",
        },
        "allow_patterns": [
            "config.json",
            "preprocessor_config.json",
            "pytorch_model.bin",
            "special_tokens_map.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "vocab.txt",
        ],
    },
    "ocr-trocr-small-printed": {
        "task": "ocr",
        "repository": "microsoft/trocr-small-printed",
        "revision": "04e994ab854b0089d4929f48c2b4dbe2ce78a340",
        "download_bytes": 247_200_667,
        "weight": {
            "filename": "model.safetensors",
            "size": 245_839_136,
            "sha256": "49350a39968df83e5a1adc90fc0ede02ff247671aed70b842af350fd4a7103f3",
        },
        "allow_patterns": [
            "config.json",
            "generation_config.json",
            "model.safetensors",
            "preprocessor_config.json",
            "sentencepiece.bpe.model",
            "special_tokens_map.json",
            "tokenizer_config.json",
        ],
    },
    "embedding-multilingual-minilm-l12-v2": {
        "task": "embedding",
        "repository": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        "revision": "e8f8c211226b894fcb81acc59f3b34ba3efd5f42",
        "download_bytes": 499_557_407,
        "weight": {
            "filename": "model.safetensors",
            "size": 470_641_600,
            "sha256": "eaa086f0ffee582aeb45b36e34cdd1fe2d6de2bef61f8a559a1bbc9bd955917b",
        },
        "allow_patterns": [
            "config.json",
            "config_sentence_transformers.json",
            "model.safetensors",
            "modules.json",
            "sentence_bert_config.json",
            "sentencepiece.bpe.model",
            "special_tokens_map.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "unigram.json",
            "1_Pooling/config.json",
        ],
        "embedding_dimension": 384,
    },
}

_LOADED: dict[str, Any] = {}


class SemanticRunnerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _safe_error_message(value: Any) -> str:
    text = str(value or "语义模型执行失败")
    text = re.sub(r"https?://[^\s\"'`<>()]+", "[remote-url]", text, flags=re.IGNORECASE)
    text = re.sub(
        r"\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b",
        "[redacted]",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"[A-Za-z]:\\[^\r\n\"'`]+", "[local-path]", text)
    text = re.sub(
        r"(^|\s)/(?:Users|home|tmp|var|private|mnt)/[^\r\n\"'`]+",
        r"\1[local-path]",
        text,
        flags=re.IGNORECASE,
    )
    return " ".join(text.split())[:600] or "语义模型执行失败"


def _write_json(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _spec(model_id: Any, expected_task: str = "") -> dict[str, Any]:
    if not isinstance(model_id, str) or model_id not in MODEL_SPECS:
        raise SemanticRunnerError("asset-semantic-model-not-allowed", "不支持的语义模型")
    spec = MODEL_SPECS[model_id]
    if expected_task and spec["task"] != expected_task:
        raise SemanticRunnerError("asset-semantic-model-task-mismatch", "语义模型与任务类型不匹配")
    return spec


def _inside(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return child == parent


def _is_link_or_junction(candidate: Path) -> bool:
    try:
        return candidate.is_symlink() or bool(getattr(candidate, "is_junction", lambda: False)())
    except OSError:
        return True


def _model_dir(model_root: str | os.PathLike[str], model_id: str) -> Path:
    _spec(model_id)
    root = Path(model_root).expanduser().resolve()
    target = (root / model_id).resolve()
    if not _inside(root, target):
        raise SemanticRunnerError("asset-semantic-model-path-invalid", "语义模型目录异常")
    return target


def _sha256_file(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as handle:
        while True:
            chunk = handle.read(4 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _reject_links(root: Path) -> None:
    for current_root, directory_names, filenames in os.walk(root, followlinks=False):
        current = Path(current_root)
        for name in [*directory_names, *filenames]:
            candidate = current / name
            if _is_link_or_junction(candidate):
                raise SemanticRunnerError(
                    "asset-semantic-model-link-rejected",
                    "模型目录包含不允许的符号链接",
                )


def _validate_download_staging(staging: Path) -> None:
    if not staging.exists():
        return
    if not staging.is_dir() or _is_link_or_junction(staging):
        raise SemanticRunnerError("asset-semantic-staging-invalid", "模型暂存目录必须是普通目录")
    entries = list(staging.iterdir())
    if not entries:
        return
    if len(entries) != 1 or entries[0].name != DOWNLOAD_OWNER_MARKER:
        raise SemanticRunnerError("asset-semantic-staging-not-empty", "模型暂存目录包含非预期文件")
    owner = entries[0]
    if _is_link_or_junction(owner) or not owner.is_file():
        raise SemanticRunnerError("asset-semantic-staging-owner-invalid", "模型暂存目录所有者标记无效")
    try:
        if owner.stat().st_size <= 0 or owner.stat().st_size > 4_096:
            raise SemanticRunnerError("asset-semantic-staging-owner-invalid", "模型暂存目录所有者标记无效")
        payload = json.loads(owner.read_text(encoding="utf-8"))
    except SemanticRunnerError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SemanticRunnerError("asset-semantic-staging-owner-invalid", "模型暂存目录所有者标记无效") from error
    if not isinstance(payload, dict) or payload.get("format") != 1 or not isinstance(payload.get("pid"), int):
        raise SemanticRunnerError("asset-semantic-staging-owner-invalid", "模型暂存目录所有者标记无效")


def _verify_model_directory(model_root: str, model_id: str) -> Path:
    spec = _spec(model_id)
    target = _model_dir(model_root, model_id)
    if not target.is_dir() or _is_link_or_junction(target):
        raise SemanticRunnerError("asset-semantic-model-not-installed", "语义模型尚未安装")
    _reject_links(target)
    marker_path = target / ".t8-semantic-model.json"
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        raise SemanticRunnerError("asset-semantic-model-invalid", "语义模型安装标记无效") from None
    weight = spec["weight"]
    if (
        marker.get("modelId") != model_id
        or marker.get("revision") != spec["revision"]
        or marker.get("weightSize") != weight["size"]
        or marker.get("weightSha256") != weight["sha256"]
    ):
        raise SemanticRunnerError("asset-semantic-model-invalid", "语义模型版本或校验信息不匹配")
    weight_path = target / weight["filename"]
    try:
        stat = weight_path.stat()
    except OSError:
        raise SemanticRunnerError("asset-semantic-model-invalid", "语义模型主权重缺失") from None
    if not weight_path.is_file() or _is_link_or_junction(weight_path) or stat.st_size != weight["size"]:
        raise SemanticRunnerError("asset-semantic-model-invalid", "语义模型主权重大小不匹配")
    if _sha256_file(weight_path) != weight["sha256"]:
        raise SemanticRunnerError("asset-semantic-model-invalid", "语义模型主权重校验失败")
    return target


def _configure_offline_runtime() -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"


def _configure_download_runtime() -> None:
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["HF_HUB_DISABLE_XET"] = "1"
    os.environ.pop("HF_XET_HIGH_PERFORMANCE", None)
    os.environ.pop("HF_HUB_OFFLINE", None)
    os.environ.pop("TRANSFORMERS_OFFLINE", None)


def _plan_download_ranges(expected_size: int, segment_size: int = WEIGHT_RANGE_BYTES) -> list[tuple[int, int]]:
    if not isinstance(expected_size, int) or expected_size <= 0:
        raise SemanticRunnerError("asset-semantic-download-size-invalid", "模型主权重大小无效")
    if not isinstance(segment_size, int) or segment_size <= 0:
        raise SemanticRunnerError("asset-semantic-download-range-invalid", "模型下载分段大小无效")
    ranges = [
        (start, min(expected_size - 1, start + segment_size - 1))
        for start in range(0, expected_size, segment_size)
    ]
    if len(ranges) > 256:
        raise SemanticRunnerError("asset-semantic-download-range-invalid", "模型下载分段数量超出限制")
    return ranges


def _official_weight_url(spec: dict[str, Any]) -> str:
    repository = str(spec.get("repository") or "")
    revision = str(spec.get("revision") or "")
    filename = str(spec.get("weight", {}).get("filename") or "")
    if (
        re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", repository) is None
        or re.fullmatch(r"[a-f0-9]{40}", revision) is None
        or re.fullmatch(r"[A-Za-z0-9._-]+", filename) is None
    ):
        raise SemanticRunnerError("asset-semantic-download-identity-invalid", "固定模型下载身份无效")
    return f"https://huggingface.co/{repository}/resolve/{revision}/{filename}"


def _validate_weight_response(response: Any, start: int, end: int, expected_size: int) -> None:
    if int(response.status_code) != 206:
        raise SemanticRunnerError("asset-semantic-download-range-invalid", "模型主权重服务器未返回分段响应")
    final_url = response.url
    hostname = str(final_url.host or "").lower()
    if (
        final_url.scheme != "https"
        or not (
            hostname == "huggingface.co"
            or hostname.endswith(".huggingface.co")
            or hostname.endswith(".hf.co")
        )
    ):
        raise SemanticRunnerError("asset-semantic-download-host-invalid", "模型主权重下载重定向不受信任")
    content_range = str(response.headers.get("content-range") or "")
    match = re.fullmatch(r"bytes\s+(\d+)-(\d+)/(\d+)", content_range, flags=re.IGNORECASE)
    if (
        match is None
        or int(match.group(1)) != start
        or int(match.group(2)) != end
        or int(match.group(3)) != expected_size
    ):
        raise SemanticRunnerError("asset-semantic-download-range-invalid", "模型主权重分段范围不匹配")
    content_length = response.headers.get("content-length")
    if content_length is not None and int(content_length) != end - start + 1:
        raise SemanticRunnerError("asset-semantic-download-range-invalid", "模型主权重分段长度不匹配")


def _download_weight_part(
    url: str,
    parts_dir: Path,
    index: int,
    start: int,
    end: int,
    expected_size: int,
) -> Path:
    import httpx

    part_path = parts_dir / f"part-{index:04d}.bin"
    expected_part_size = end - start + 1
    try:
        if part_path.exists() and (_is_link_or_junction(part_path) or not part_path.is_file()):
            raise SemanticRunnerError("asset-semantic-download-range-invalid", "模型主权重分段文件无效")
        if part_path.is_file():
            existing_size = part_path.stat().st_size
            if existing_size == expected_part_size:
                return part_path
            if existing_size > expected_part_size:
                part_path.unlink()
    except OSError:
        part_path.unlink(missing_ok=True)
    last_error: Exception | None = None
    for attempt in range(WEIGHT_DOWNLOAD_ATTEMPTS):
        try:
            existing_size = part_path.stat().st_size if part_path.is_file() else 0
            if existing_size == expected_part_size:
                return part_path
            if existing_size < 0 or existing_size > expected_part_size:
                raise SemanticRunnerError("asset-semantic-download-range-invalid", "模型主权重分段文件长度无效")
            request_start = start + existing_size
            timeout = httpx.Timeout(connect=30.0, read=60.0, write=30.0, pool=30.0)
            # The host process forwards only credential-free proxy variables.
            # Honour that sanitized environment so corporate/local proxies work.
            with httpx.Client(follow_redirects=True, timeout=timeout, trust_env=True) as client:
                with client.stream(
                    "GET",
                    url,
                    headers={
                        "Accept-Encoding": "identity",
                        "Range": f"bytes={request_start}-{end}",
                        "User-Agent": "t8-penguin-canvas-asset-semantic/1",
                    },
                ) as response:
                    _validate_weight_response(response, request_start, end, expected_size)
                    written = existing_size
                    with part_path.open("ab") as handle:
                        for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                            if not chunk:
                                continue
                            written += len(chunk)
                            if written > expected_part_size:
                                raise SemanticRunnerError(
                                    "asset-semantic-download-range-invalid",
                                    "模型主权重分段数据超过固定长度",
                                )
                            handle.write(chunk)
                        handle.flush()
                        os.fsync(handle.fileno())
                    if written != expected_part_size:
                        raise SemanticRunnerError(
                            "asset-semantic-download-range-invalid",
                            "模型主权重分段数据长度不完整",
                        )
                    return part_path
        except Exception as error:
            try:
                if part_path.is_file() and part_path.stat().st_size > expected_part_size:
                    part_path.unlink()
            except OSError:
                part_path.unlink(missing_ok=True)
            last_error = error
            if attempt + 1 < WEIGHT_DOWNLOAD_ATTEMPTS:
                time.sleep(min(8, 2 ** attempt))
    if isinstance(last_error, SemanticRunnerError):
        raise last_error
    raise SemanticRunnerError(
        "asset-semantic-download-range-failed",
        _safe_error_message(last_error),
    ) from None


def _download_fixed_weight(staging: Path, spec: dict[str, Any]) -> None:
    weight = spec["weight"]
    expected_size = int(weight["size"])
    ranges = _plan_download_ranges(expected_size, WEIGHT_RANGE_BYTES)
    parts_dir = staging / ".t8-weight-parts"
    if parts_dir.exists():
        if not parts_dir.is_dir() or _is_link_or_junction(parts_dir):
            raise SemanticRunnerError("asset-semantic-download-range-invalid", "模型主权重分段目录无效")
    else:
        parts_dir.mkdir(parents=False)
    url = _official_weight_url(spec)
    expected_part_names = {f"part-{index:04d}.bin" for index in range(len(ranges))}
    with ThreadPoolExecutor(max_workers=min(WEIGHT_DOWNLOAD_WORKERS, len(ranges))) as executor:
        futures = {
            executor.submit(_download_weight_part, url, parts_dir, index, start, end, expected_size): index
            for index, (start, end) in enumerate(ranges)
        }
        for future in as_completed(futures):
            future.result()

    actual_part_names = {entry.name for entry in parts_dir.iterdir()}
    if actual_part_names != expected_part_names or any(
        not entry.is_file() or _is_link_or_junction(entry)
        for entry in parts_dir.iterdir()
    ):
        raise SemanticRunnerError("asset-semantic-download-range-invalid", "模型主权重分段目录包含额外文件")

    assembling = staging / f".{weight['filename']}.assembling"
    destination = staging / weight["filename"]
    assembling.unlink(missing_ok=True)
    try:
        with assembling.open("wb") as output:
            for index, (start, end) in enumerate(ranges):
                part_path = parts_dir / f"part-{index:04d}.bin"
                expected_part_size = end - start + 1
                if not part_path.is_file() or part_path.stat().st_size != expected_part_size:
                    raise SemanticRunnerError("asset-semantic-download-range-invalid", "模型主权重分段文件不完整")
                with part_path.open("rb") as source:
                    shutil.copyfileobj(source, output, length=4 * 1024 * 1024)
                # Reclaim each completed segment immediately. This keeps peak
                # disk use near one weight plus the not-yet-assembled tail.
                part_path.unlink()
            output.flush()
            os.fsync(output.fileno())
        if assembling.stat().st_size != expected_size:
            raise SemanticRunnerError("asset-semantic-download-size-mismatch", "下载的模型主权重大小不匹配")
        os.replace(assembling, destination)
    finally:
        assembling.unlink(missing_ok=True)
    parts_dir.rmdir()


def _validate_download_snapshot(staging: Path, spec: dict[str, Any]) -> None:
    expected_files = {str(item).replace("\\", "/") for item in spec["allow_patterns"]}
    expected_directories = {
        parent.as_posix()
        for filename in expected_files
        for parent in [Path(filename).parent]
        if parent.as_posix() != "."
    }
    actual_files: set[str] = set()
    actual_directories: set[str] = set()
    total_bytes = 0
    inspected = 0
    for entry in staging.rglob("*"):
        inspected += 1
        if inspected > 128:
            raise SemanticRunnerError("asset-semantic-download-files-mismatch", "模型快照文件数量超出限制")
        if _is_link_or_junction(entry):
            raise SemanticRunnerError("asset-semantic-download-files-mismatch", "模型快照包含不允许的链接")
        relative = entry.relative_to(staging).as_posix()
        if relative == DOWNLOAD_OWNER_MARKER:
            if not entry.is_file():
                raise SemanticRunnerError("asset-semantic-download-files-mismatch", "模型下载所有者标记无效")
            continue
        if entry.is_dir():
            actual_directories.add(relative)
            continue
        if not entry.is_file():
            raise SemanticRunnerError("asset-semantic-download-files-mismatch", "模型快照包含非普通文件")
        actual_files.add(relative)
        total_bytes += entry.stat().st_size
    if actual_files != expected_files or actual_directories != expected_directories:
        raise SemanticRunnerError("asset-semantic-download-files-mismatch", "模型快照文件集合与固定清单不匹配")
    if total_bytes != int(spec["download_bytes"]):
        raise SemanticRunnerError("asset-semantic-download-size-mismatch", "模型快照总大小与固定清单不匹配")


def _configure_torch(torch: Any) -> None:
    try:
        torch.set_num_threads(max(1, min(4, int(os.cpu_count() or 1))))
    except (RuntimeError, TypeError, ValueError):
        pass


def _read_proto_varint(data: bytes, position: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while position < len(data) and shift <= 63:
        byte = data[position]
        position += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, position
        shift += 7
    raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer protobuf 无效")


def _iter_proto_fields(data: bytes):
    position = 0
    while position < len(data):
        tag, position = _read_proto_varint(data, position)
        field_number = tag >> 3
        wire_type = tag & 0x07
        if field_number <= 0:
            raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer protobuf 字段无效")
        if wire_type == 0:
            value, position = _read_proto_varint(data, position)
        elif wire_type == 1:
            end = position + 8
            if end > len(data):
                raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer protobuf 被截断")
            value = data[position:end]
            position = end
        elif wire_type == 2:
            length, position = _read_proto_varint(data, position)
            end = position + length
            if length > len(data) or end > len(data):
                raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer protobuf 被截断")
            value = data[position:end]
            position = end
        elif wire_type == 5:
            end = position + 4
            if end > len(data):
                raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer protobuf 被截断")
            value = data[position:end]
            position = end
        else:
            raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer protobuf wire type 无效")
        yield field_number, wire_type, value


def _load_sentencepiece_unigram(filename: Path) -> tuple[Any, int]:
    """Load the pinned XLM-R SentencePiece model without a native extension.

    The bundled runtime contains Rust `tokenizers` and protobuf but not the
    optional `sentencepiece` wheel. Parsing the small, fixed protobuf here keeps
    OCR offline and avoids a hidden dependency/download at first use.
    """
    try:
        payload = filename.read_bytes()
    except OSError:
        raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer 文件缺失") from None
    if not payload or len(payload) > 8 * 1024 * 1024:
        raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer 文件大小无效")
    pieces: list[tuple[str, float]] = []
    unk_id = 0
    model_type = 1
    byte_fallback = False
    precompiled_charsmap = b""
    for field_number, wire_type, value in _iter_proto_fields(payload):
        if field_number == 1 and wire_type == 2:
            piece = ""
            score = 0.0
            for piece_field, piece_wire, piece_value in _iter_proto_fields(value):
                if piece_field == 1 and piece_wire == 2:
                    try:
                        piece = piece_value.decode("utf-8")
                    except UnicodeDecodeError:
                        raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer token 编码无效") from None
                elif piece_field == 2 and piece_wire == 5:
                    score = struct.unpack("<f", piece_value)[0]
            if not piece or len(piece) > 16_384 or not math.isfinite(score):
                raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer token 无效")
            pieces.append((piece, float(score)))
            if len(pieces) > 100_000:
                raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer 词表超出限制")
        elif field_number == 2 and wire_type == 2:
            for trainer_field, trainer_wire, trainer_value in _iter_proto_fields(value):
                if trainer_field == 3 and trainer_wire == 0:
                    model_type = int(trainer_value)
                elif trainer_field == 35 and trainer_wire == 0:
                    byte_fallback = bool(trainer_value)
                elif trainer_field == 40 and trainer_wire == 0:
                    unk_id = int(trainer_value)
        elif field_number == 3 and wire_type == 2:
            for normalizer_field, normalizer_wire, normalizer_value in _iter_proto_fields(value):
                if normalizer_field == 2 and normalizer_wire == 2:
                    precompiled_charsmap = normalizer_value
    if model_type != 1 or len(pieces) < 100 or not (0 <= unk_id < len(pieces)):
        raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer 不是受支持的 Unigram 模型")

    from tokenizers import Regex, Tokenizer, decoders, normalizers, pre_tokenizers
    from tokenizers.models import Unigram

    tokenizer = Tokenizer(Unigram(pieces, unk_id, byte_fallback))
    replacement = "\u2581"
    if precompiled_charsmap:
        tokenizer.normalizer = normalizers.Sequence([
            normalizers.Precompiled(precompiled_charsmap),
            normalizers.Replace(Regex(" {2,}"), " "),
        ])
    else:
        tokenizer.normalizer = normalizers.Sequence([normalizers.Replace(Regex(" {2,}"), " ")])
    tokenizer.pre_tokenizer = pre_tokenizers.Metaspace(replacement=replacement, prepend_scheme="always")
    tokenizer.decoder = decoders.Metaspace(replacement=replacement, prepend_scheme="always")
    return tokenizer, len(pieces)


def _decode_trocr_ids(tokenizer: Any, token_ids: Any, sentencepiece_size: int) -> str:
    # XLM-R/Fairseq reserves ids 0..3 and shifts ordinary SentencePiece ids by
    # one. Its trailing mask token is outside the SentencePiece vocabulary.
    sentencepiece_ids = []
    for raw_value in token_ids:
        value = int(raw_value)
        if value in (0, 1, 2, 3):
            continue
        sentencepiece_id = value - 1
        if 0 <= sentencepiece_id < sentencepiece_size:
            sentencepiece_ids.append(sentencepiece_id)
    return tokenizer.decode(sentencepiece_ids, skip_special_tokens=False).strip()


def _clear_loaded(model_id: str = "") -> None:
    global _LOADED
    if model_id and _LOADED.get("modelId") not in (None, model_id):
        return
    _LOADED = {}
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except (ImportError, RuntimeError):
        pass


def _load_model(model_root: str, model_id: str) -> dict[str, Any]:
    global _LOADED
    if _LOADED.get("modelId") == model_id:
        return _LOADED
    _clear_loaded()
    spec = _spec(model_id)
    model_dir = _verify_model_directory(model_root, model_id)
    import torch
    from transformers import (
        AutoModel,
        AutoTokenizer,
        BlipForConditionalGeneration,
        BlipProcessor,
        DeiTImageProcessor,
        VisionEncoderDecoderModel,
    )
    from transformers.utils import logging as transformers_logging

    _configure_torch(torch)
    transformers_logging.set_verbosity_error()
    transformers_logging.disable_progress_bar()
    common = {
        "local_files_only": True,
        "trust_remote_code": False,
    }
    if spec["task"] == "caption":
        processor = BlipProcessor.from_pretrained(str(model_dir), **common)
        model = BlipForConditionalGeneration.from_pretrained(str(model_dir), **common)
        loaded = {"modelId": model_id, "processor": processor, "model": model.eval(), "torch": torch}
    elif spec["task"] == "ocr":
        processor = DeiTImageProcessor.from_pretrained(str(model_dir), **common)
        tokenizer, sentencepiece_size = _load_sentencepiece_unigram(model_dir / "sentencepiece.bpe.model")
        model = VisionEncoderDecoderModel.from_pretrained(str(model_dir), **common)
        decoder_vocab_size = int(getattr(model.config.decoder, "vocab_size", 0) or 0)
        tokenizer_vocab_size = sentencepiece_size + 2
        # The pinned checkpoint pads its decoder head by 42 ids beyond the
        # XLM-R tokenizer. The official tokenizer decodes those ids as empty;
        # accept only a small bounded padding tail and ignore it likewise.
        if decoder_vocab_size < tokenizer_vocab_size or decoder_vocab_size > tokenizer_vocab_size + 256:
            raise SemanticRunnerError("asset-semantic-tokenizer-invalid", "TrOCR tokenizer 与模型词表维度不匹配")
        loaded = {
            "modelId": model_id,
            "processor": processor,
            "tokenizer": tokenizer,
            "sentencepieceSize": sentencepiece_size,
            "model": model.eval(),
            "torch": torch,
        }
    else:
        tokenizer = AutoTokenizer.from_pretrained(str(model_dir), **common)
        model = AutoModel.from_pretrained(str(model_dir), **common)
        loaded = {"modelId": model_id, "tokenizer": tokenizer, "model": model.eval(), "torch": torch}
    _LOADED = loaded
    return loaded


def _open_image(source_path: Any) -> Any:
    if not isinstance(source_path, str) or not source_path or not os.path.isabs(source_path):
        raise SemanticRunnerError("asset-semantic-source-invalid", "语义图像源路径无效")
    source = Path(source_path)
    try:
        stat = source.lstat()
    except OSError:
        raise SemanticRunnerError("asset-semantic-source-missing", "语义图像源不存在") from None
    if _is_link_or_junction(source) or not source.is_file():
        raise SemanticRunnerError("asset-semantic-source-invalid", "语义图像源必须是普通文件")
    if stat.st_size <= 0 or stat.st_size > MAX_IMAGE_BYTES:
        raise SemanticRunnerError("asset-semantic-source-too-large", "语义图像源大小超出限制")
    try:
        from PIL import Image, ImageOps

        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        with Image.open(source) as opened:
            width, height = opened.size
            if (
                width <= 0
                or height <= 0
                or width > MAX_IMAGE_EDGE
                or height > MAX_IMAGE_EDGE
                or width * height > MAX_IMAGE_PIXELS
            ):
                raise SemanticRunnerError("asset-semantic-source-too-large", "语义图像像素尺寸超出限制")
            opened.verify()
        with Image.open(source) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
            image.load()
    except SemanticRunnerError:
        raise
    except Exception as error:
        raise SemanticRunnerError("asset-semantic-source-corrupt", _safe_error_message(error)) from None
    width, height = image.size
    if (
        width <= 0
        or height <= 0
        or width > MAX_IMAGE_EDGE
        or height > MAX_IMAGE_EDGE
        or width * height > MAX_IMAGE_PIXELS
    ):
        raise SemanticRunnerError("asset-semantic-source-too-large", "语义图像像素尺寸超出限制")
    return image


def _caption(model_root: str, model_id: str, source_path: Any) -> dict[str, Any]:
    loaded = _load_model(model_root, model_id)
    image = _open_image(source_path)
    processor = loaded["processor"]
    model = loaded["model"]
    torch = loaded["torch"]
    inputs = processor(images=image, return_tensors="pt")
    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=64, num_beams=3)
    text = processor.decode(generated[0], skip_special_tokens=True).strip()[:MAX_CAPTION_CHARS]
    return {"task": "caption", "text": text, "caption": text}


def _segment_text_lines(image: Any) -> list[Any]:
    """Return at most 16 reading-order crops using bounded OpenCV projection."""
    import cv2
    import numpy as np

    width, height = image.size
    scale = min(1.0, 2048.0 / max(width, height))
    small_width = max(1, int(round(width * scale)))
    small_height = max(1, int(round(height * scale)))
    gray = cv2.cvtColor(np.asarray(image.resize((small_width, small_height))), cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    ink_per_row = (binary > 0).mean(axis=1)
    active = ink_per_row >= max(0.002, min(0.03, 3.0 / max(1, small_width)))
    runs: list[list[int]] = []
    start = -1
    for index, value in enumerate(active.tolist() + [False]):
        if value and start < 0:
            start = index
        elif not value and start >= 0:
            if index - start >= 2:
                runs.append([start, index])
            start = -1
    merge_gap = max(2, min(16, small_height // 160))
    merged: list[list[int]] = []
    for run in runs:
        if merged and run[0] - merged[-1][1] <= merge_gap:
            merged[-1][1] = run[1]
        else:
            merged.append(run)
    if not merged:
        return [image]
    padding = max(2, small_height // 200)
    crops = []
    for top, bottom in merged[:MAX_OCR_LINES]:
        y0 = max(0, int(math.floor((top - padding) / scale)))
        y1 = min(height, int(math.ceil((bottom + padding) / scale)))
        if y1 <= y0:
            continue
        crop = image.crop((0, y0, width, y1))
        if crop.width > 4096 or crop.height > 1024:
            crop.thumbnail((4096, 1024))
        crops.append(crop)
    return crops or [image]


def _ocr(model_root: str, model_id: str, source_path: Any) -> dict[str, Any]:
    loaded = _load_model(model_root, model_id)
    image = _open_image(source_path)
    lines = _segment_text_lines(image)[:MAX_OCR_LINES]
    processor = loaded["processor"]
    model = loaded["model"]
    torch = loaded["torch"]
    recognized: list[str] = []
    for line in lines:
        pixel_values = processor(images=line, return_tensors="pt").pixel_values
        with torch.inference_mode():
            generated = model.generate(pixel_values, max_new_tokens=128, num_beams=2)
        text = _decode_trocr_ids(loaded["tokenizer"], generated[0].cpu().tolist(), loaded["sentencepieceSize"])
        if text:
            recognized.append(text[:512])
        if sum(len(item) for item in recognized) >= MAX_OCR_CHARS:
            break
    combined = "\n".join(recognized)[:MAX_OCR_CHARS]
    return {
        "task": "ocr",
        "text": combined,
        "lines": recognized,
        "lineCount": len(recognized),
    }


def _embedding(model_root: str, model_id: str, text: Any) -> dict[str, Any]:
    if not isinstance(text, str) or not text.strip():
        raise SemanticRunnerError("asset-semantic-text-required", "向量任务需要非空文本")
    normalized_text = text.strip()[:MAX_EMBEDDING_TEXT_CHARS]
    loaded = _load_model(model_root, model_id)
    tokenizer = loaded["tokenizer"]
    model = loaded["model"]
    torch = loaded["torch"]
    encoded = tokenizer(
        [normalized_text],
        padding=True,
        truncation=True,
        max_length=256,
        return_tensors="pt",
    )
    with torch.inference_mode():
        token_embeddings = model(**encoded).last_hidden_state
    mask = encoded["attention_mask"].unsqueeze(-1).expand(token_embeddings.size()).float()
    pooled = torch.sum(token_embeddings * mask, 1) / torch.clamp(mask.sum(1), min=1e-9)
    pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)
    vector = [round(float(value), 8) for value in pooled[0].cpu().tolist()]
    expected_dimension = int(_spec(model_id)["embedding_dimension"])
    if len(vector) != expected_dimension or any(not math.isfinite(value) for value in vector):
        raise SemanticRunnerError("asset-semantic-embedding-invalid", "向量模型返回了无效维度或数值")
    return {
        "task": "embedding",
        "textLength": len(normalized_text),
        "dimension": expected_dimension,
        "vector": vector,
    }


def _execute_request(model_root: str, request: dict[str, Any]) -> dict[str, Any]:
    allowed = {"id", "op", "modelId", "task", "sourcePath", "text"}
    unexpected = sorted(set(request) - allowed)
    if unexpected:
        raise SemanticRunnerError("asset-semantic-request-field-not-allowed", "语义请求包含不允许的字段")
    model_id = request.get("modelId")
    task = request.get("task")
    if task not in {"caption", "ocr", "embedding"}:
        raise SemanticRunnerError("asset-semantic-task-invalid", "不支持的语义任务")
    _spec(model_id, task)
    if task == "caption":
        return _caption(model_root, model_id, request.get("sourcePath"))
    if task == "ocr":
        return _ocr(model_root, model_id, request.get("sourcePath"))
    return _embedding(model_root, model_id, request.get("text"))


def _worker(model_root: str) -> int:
    _configure_offline_runtime()
    root = Path(model_root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    while True:
        raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
        if not raw:
            break
        if len(raw) > MAX_REQUEST_BYTES and not raw.endswith(b"\n"):
            while raw and not raw.endswith(b"\n"):
                raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
            _write_json({
                "id": None,
                "ok": False,
                "error": {"code": "asset-semantic-request-too-large", "message": "语义请求超过大小限制"},
            })
            continue
        request_id: str | None = None
        try:
            request = json.loads(raw.decode("utf-8"))
            if not isinstance(request, dict):
                raise SemanticRunnerError("asset-semantic-request-invalid", "语义请求必须是 JSON 对象")
            request_id_value = request.get("id")
            if not isinstance(request_id_value, str) or not request_id_value or len(request_id_value) > 128:
                raise SemanticRunnerError("asset-semantic-request-id-invalid", "语义请求 ID 无效")
            request_id = request_id_value
            operation = request.get("op")
            if operation == "ping":
                result = {"protocolVersion": PROTOCOL_VERSION, "ready": True}
            elif operation == "unload":
                allowed = {"id", "op", "modelId"}
                if set(request) - allowed:
                    raise SemanticRunnerError("asset-semantic-request-field-not-allowed", "语义请求包含不允许的字段")
                model_id = request.get("modelId", "")
                if model_id:
                    _spec(model_id)
                _clear_loaded(model_id)
                result = {"unloaded": True}
            elif operation == "execute":
                result = _execute_request(str(root), request)
            elif operation == "shutdown":
                _write_json({"id": request_id, "ok": True, "result": {"closed": True}})
                _clear_loaded()
                return 0
            else:
                raise SemanticRunnerError("asset-semantic-operation-invalid", "不支持的语义 worker 操作")
            _write_json({"id": request_id, "ok": True, "result": result})
        except Exception as error:
            code = getattr(error, "code", "asset-semantic-runtime-failed")
            _write_json({
                "id": request_id,
                "ok": False,
                "error": {"code": str(code)[:120], "message": _safe_error_message(error)},
            })
    _clear_loaded()
    return 0


def _download(model_id: str, staging_dir: str) -> int:
    spec = _spec(model_id)
    raw_staging = Path(staging_dir).expanduser()
    if raw_staging.exists() and _is_link_or_junction(raw_staging):
        raise SemanticRunnerError("asset-semantic-staging-invalid", "模型暂存目录必须是普通目录")
    staging = raw_staging.resolve()
    _validate_download_staging(staging)
    staging.mkdir(parents=True, exist_ok=True)
    # The bundled runtime includes hf_xet, but its native Windows downloader can
    # leave completed HTTPS connections in CLOSE_WAIT without advancing the
    # destination file. Use the Hub's resumable HTTP path for deterministic,
    # observable writes; identity, revision and hashes remain fixed below.
    _configure_download_runtime()
    from huggingface_hub import snapshot_download

    weight = spec["weight"]
    snapshot_download(
        repo_id=spec["repository"],
        revision=spec["revision"],
        local_dir=staging,
        allow_patterns=[pattern for pattern in spec["allow_patterns"] if pattern != weight["filename"]],
        token=False,
        endpoint="https://huggingface.co",
        max_workers=4,
    )
    _download_fixed_weight(staging, spec)
    _reject_links(staging)
    weight_path = staging / weight["filename"]
    if not weight_path.is_file() or weight_path.stat().st_size != weight["size"]:
        raise SemanticRunnerError("asset-semantic-download-size-mismatch", "下载的模型主权重大小不匹配")
    if _sha256_file(weight_path) != weight["sha256"]:
        raise SemanticRunnerError("asset-semantic-download-hash-mismatch", "下载的模型主权重校验失败")
    # Hugging Face's local metadata is not needed at runtime and can contain
    # upstream URLs. Remove it before the host installs the verified snapshot.
    shutil.rmtree(staging / ".cache", ignore_errors=True)
    _validate_download_snapshot(staging, spec)
    _write_json({
        "ok": True,
        "result": {
            "modelId": model_id,
            "revision": spec["revision"],
            "weightSize": weight["size"],
            "weightSha256": weight["sha256"],
        },
    })
    return 0


def _probe() -> int:
    import importlib.util
    import cv2
    import huggingface_hub
    import PIL
    import torch
    import tokenizers
    import transformers
    from transformers import (
        AutoModel,
        AutoTokenizer,
        BlipForConditionalGeneration,
        BlipProcessor,
        TrOCRProcessor,
        VisionEncoderDecoderModel,
    )

    classes_available = all(
        value is not None
        for value in (
            AutoModel,
            AutoTokenizer,
            BlipForConditionalGeneration,
            BlipProcessor,
            TrOCRProcessor,
            VisionEncoderDecoderModel,
        )
    )
    _write_json({
        "ok": True,
        "protocolVersion": PROTOCOL_VERSION,
        "python": sys.version.split()[0],
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "huggingfaceHub": huggingface_hub.__version__,
        "pillow": PIL.__version__,
        "opencv": cv2.__version__,
        "tokenizers": tokenizers.__version__,
        "directClasses": classes_available,
        "nativeSentencepiece": importlib.util.find_spec("sentencepiece") is not None,
        "trocrTokenizerAdapter": True,
        "modelIds": sorted(MODEL_SPECS),
    })
    return 0


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--worker", action="store_true")
    mode.add_argument("--download", action="store_true")
    mode.add_argument("--probe", action="store_true")
    parser.add_argument("--model-root", default="")
    parser.add_argument("--model-id", default="")
    parser.add_argument("--staging-dir", default="")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(list(argv if argv is not None else sys.argv[1:]))
    try:
        if args.probe:
            return _probe()
        if args.download:
            if not args.model_id or not args.staging_dir:
                raise SemanticRunnerError("asset-semantic-download-invalid", "模型下载参数不完整")
            return _download(args.model_id, args.staging_dir)
        if not args.model_root:
            raise SemanticRunnerError("asset-semantic-model-root-required", "语义模型目录未配置")
        return _worker(args.model_root)
    except Exception as error:
        code = getattr(error, "code", "asset-semantic-runtime-failed")
        _write_json({
            "ok": False,
            "error": {"code": str(code)[:120], "message": _safe_error_message(error)},
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
