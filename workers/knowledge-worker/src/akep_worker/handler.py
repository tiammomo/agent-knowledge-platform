from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from functools import lru_cache
from html.parser import HTMLParser
from typing import Any

import rfc8785
from jsonschema.exceptions import ValidationError

from .contracts import ContractSet

TASK_SCHEMA_ID = "https://agentknowledge.dev/internal/worker-task/0.1"
RESULT_SCHEMA_ID = "https://agentknowledge.dev/internal/worker-result/0.1"


@lru_cache(maxsize=1)
def contracts() -> ContractSet:
    return ContractSet.load()


def revision_id(manifest: object) -> str:
    digest = hashlib.sha256(rfc8785.dumps(manifest)).hexdigest()
    return f"urn:akep:sha256:{digest}"


def handle_task(task: object) -> dict[str, Any]:
    contract_set = contracts()
    task_errors = contract_set.validate(TASK_SCHEMA_ID, task)
    if task_errors:
        raise ValueError(_format_envelope_error(task_errors[0]))

    assert isinstance(task, dict)
    if task["kind"] == "process_payload":
        result = _process_payload(task)
        result_errors = contract_set.validate(RESULT_SCHEMA_ID, result)
        if result_errors:
            raise RuntimeError(_format_envelope_error(result_errors[0]))
        return result

    result = _validate_manifest(task, contract_set)
    result_errors = contract_set.validate(RESULT_SCHEMA_ID, result)
    if result_errors:
        raise RuntimeError(_format_envelope_error(result_errors[0]))
    return result


def _validate_manifest(task: dict[str, Any], contract_set: ContractSet) -> dict[str, Any]:
    manifest = task["manifest"]
    computed_revision_id = revision_id(manifest)
    manifest_errors = contract_set.validate("asset-manifest.schema.json", manifest)
    errors = [_as_error(error) for error in manifest_errors]

    claimed_revision_id = task.get("claimedRevisionId")
    if claimed_revision_id is not None and claimed_revision_id != computed_revision_id:
        errors.append(
            {
                "path": "/claimedRevisionId",
                "code": "revision_id_mismatch",
                "message": "claimedRevisionId does not match the canonical manifest digest",
            }
        )

    result = {
        "contractVersion": "0.1",
        "taskId": task["taskId"],
        "kind": "validate_manifest",
        "status": "invalid" if errors else "valid",
        "computedRevisionId": computed_revision_id,
        "errors": errors[:100],
        "critical": [],
    }
    return result


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        normalized = " ".join(data.split())
        if normalized:
            self.parts.append(normalized)

    def text(self) -> str:
        return "\n".join(self.parts)


def _process_payload(task: dict[str, Any]) -> dict[str, Any]:
    payload = task["payload"]
    errors: list[dict[str, str]] = []
    try:
        raw = base64.b64decode(payload["data"], validate=True)
        if base64.b64encode(raw).decode("ascii") != payload["data"]:
            raise ValueError("non-canonical base64")
    except (binascii.Error, ValueError):
        raw = b""
        errors.append(
            {
                "path": "/payload/data",
                "code": "payload.invalid_base64",
                "message": "payload data is not canonical base64",
            }
        )

    digest = f"sha256:{hashlib.sha256(raw).hexdigest()}"
    if digest != payload["digest"]:
        errors.append(
            {
                "path": "/payload/digest",
                "code": "payload.digest_mismatch",
                "message": "payload digest does not match decoded bytes",
            }
        )
    if len(raw) != payload["size"]:
        errors.append(
            {
                "path": "/payload/size",
                "code": "payload.size_mismatch",
                "message": "payload size does not match decoded bytes",
            }
        )

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = ""
        errors.append(
            {
                "path": "/payload/data",
                "code": "payload.invalid_utf8",
                "message": "the P0 text ingestion path requires UTF-8 content",
            }
        )

    if not errors:
        try:
            text = _normalize_text(text, payload["mediaType"])
        except json.JSONDecodeError:
            text = ""
            errors.append(
                {
                    "path": "/payload/data",
                    "code": "payload.invalid_json",
                    "message": "application/json payload is not valid JSON",
                }
            )
    normalized_digest = f"sha256:{hashlib.sha256(text.encode()).hexdigest()}"
    findings = _scan_text(text)
    quarantined = any(finding["severity"] == "high" for finding in findings)
    processing = task.get("processing", {})
    max_characters = processing.get("maxChunkCharacters", 1200)
    overlap = min(processing.get("overlapCharacters", 120), max_characters // 4)
    chunks = (
        []
        if errors or quarantined
        else _chunk_text(text, normalized_digest, max_characters, overlap)
    )
    verdict = "quarantined" if quarantined else "review" if findings else "clean"
    return {
        "contractVersion": "0.1",
        "taskId": task["taskId"],
        "kind": "process_payload",
        "status": "invalid" if errors else "quarantined" if quarantined else "processed",
        "normalizedContentDigest": normalized_digest,
        "chunks": chunks,
        "scan": {
            "basisDigest": normalized_digest,
            "externalMalwareScanRequired": True,
            "findings": findings,
            "offsetUnit": "utf8-byte",
            "scannerVersion": "akep-static-content-scan/1",
            "verdict": verdict,
        },
        "errors": errors,
        "critical": [],
    }


def _normalize_text(value: str, media_type: str) -> str:
    if media_type.startswith("text/html"):
        parser = _TextExtractor()
        parser.feed(value)
        value = parser.text()
    elif media_type.startswith("application/json"):
        parsed = json.loads(value)
        value = json.dumps(parsed, ensure_ascii=False, indent=2, sort_keys=True)
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    return "\n".join(line.rstrip() for line in value.splitlines()).strip()


_SCAN_RULES: tuple[tuple[str, str, str, re.Pattern[str]], ...] = (
    (
        "secret.private_key",
        "high",
        "Private key material must never enter the knowledge index.",
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", re.IGNORECASE),
    ),
    (
        "secret.credential",
        "high",
        "A credential-shaped value requires quarantine and manual handling.",
        re.compile(r"(?i)\b(?:api[_-]?key|secret|password)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{16,}"),
    ),
    (
        "content.prompt_injection",
        "medium",
        "Instruction-like content must remain untrusted and requires reviewer attention.",
        re.compile(
            r"(?i)(?:ignore|disregard) (?:all )?(?:previous|system) instructions"
            r"|忽略(?:以上|之前|系统)指令"
        ),
    ),
    (
        "pii.email",
        "low",
        "An email address may require redaction under the Space privacy policy.",
        re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
    ),
)


def _scan_text(value: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    byte_offsets = _utf8_byte_offsets(value)
    for code, severity, message, pattern in _SCAN_RULES:
        for match in pattern.finditer(value):
            findings.append(
                {
                    "code": code,
                    "severity": severity,
                    "message": message,
                    "start": byte_offsets[match.start()],
                    "end": byte_offsets[match.end()],
                }
            )
            if len(findings) == 100:
                return findings
    return findings


def _chunk_text(
    value: str, basis_digest: str, max_characters: int, overlap: int
) -> list[dict[str, Any]]:
    if not value:
        return []
    chunks: list[dict[str, Any]] = []
    start = 0
    ordinal = 0
    byte_offsets = _utf8_byte_offsets(value)
    while start < len(value):
        hard_end = min(start + max_characters, len(value))
        end = hard_end
        if hard_end < len(value):
            candidates = [value.rfind("\n", start + max_characters // 2, hard_end)]
            candidates.append(value.rfind(" ", start + max_characters // 2, hard_end))
            end = max(candidates)
            if end <= start:
                end = hard_end
        selected = value[start:end]
        left_trim = len(selected) - len(selected.lstrip())
        right_trim = len(selected) - len(selected.rstrip())
        content_start = start + left_trim
        content_end = end - right_trim
        content = value[content_start:content_end]
        if content:
            content_digest = f"sha256:{hashlib.sha256(content.encode()).hexdigest()}"
            byte_start = byte_offsets[content_start]
            byte_end = byte_offsets[content_end]
            identity = (
                f"{basis_digest}\0{byte_start}\0{byte_end}\0{content_digest}".encode()
            )
            chunk_digest = hashlib.sha256(identity).hexdigest()
            chunks.append(
                {
                    "chunkId": f"urn:akep:chunk:sha256:{chunk_digest}",
                    "ordinal": ordinal,
                    "content": content,
                    "contentDigest": content_digest,
                    "locator": {
                        "basisDigest": basis_digest,
                        "type": "text-offset",
                        "unit": "utf8-byte",
                        "start": byte_start,
                        "end": byte_end,
                    },
                }
            )
            ordinal += 1
        if end >= len(value):
            break
        start = max(end - overlap, start + 1)
    return chunks


def _utf8_byte_offsets(value: str) -> list[int]:
    offsets = [0]
    total = 0
    for character in value:
        total += len(character.encode("utf-8"))
        offsets.append(total)
    return offsets


def _as_error(error: ValidationError) -> dict[str, str]:
    path = "/" + "/".join(_escape_pointer(str(part)) for part in error.absolute_path)
    return {
        "path": path,
        "code": f"schema.{error.validator}",
        "message": error.message,
    }


def _escape_pointer(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _format_envelope_error(error: ValidationError) -> str:
    path = "/" + "/".join(str(part) for part in error.absolute_path)
    return f"invalid worker envelope at {path}: {error.message}"
