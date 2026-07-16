from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Callable, Mapping, Sequence
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen


class AKEPError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, trace_id: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.trace_id = trace_id


class AKEPClient:
    def __init__(
        self,
        base_url: str,
        token: str | Callable[[], str],
        supported_obligations: Sequence[Any] = ("cite", "no-train"),
        timeout_seconds: float = 15.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.supported_obligations = tuple(supported_obligations)
        self.timeout_seconds = timeout_seconds

    def discover(self) -> Mapping[str, Any]:
        origin = urljoin(self.base_url + "/", "/.well-known/akep")
        return self._request(origin, authenticated=False)

    def query(
        self,
        text: str,
        purpose: str,
        *,
        spaces: Sequence[str] | None = None,
        limit: int = 10,
        mode: str = "lexical",
        cursor: str | None = None,
        filters: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]:
        body: dict[str, Any] = {
            "akepVersion": "0.1",
            "query": {"text": text},
            "mode": mode,
            "purpose": purpose,
            "limit": limit,
            "include": ["summary", "passages", "provenance", "attestations"],
            "supportedObligations": list(self.supported_obligations),
            "critical": [],
            "extensions": {},
        }
        if spaces is not None:
            body["spaces"] = list(spaces)
        if cursor is not None:
            body["cursor"] = cursor
        if filters is not None:
            body["filters"] = dict(filters)
        return self._request(f"{self.base_url}/queries", method="POST", body=body)

    def create_context_pack(
        self,
        task: str,
        purpose: str,
        *,
        spaces: Sequence[str] | None = None,
        budget_characters: int = 12_000,
    ) -> Mapping[str, Any]:
        body: dict[str, Any] = {
            "akepVersion": "0.1",
            "task": task,
            "purpose": purpose,
            "budget": {"maxCharacters": budget_characters},
            "mode": "lexical",
            "supportedObligations": list(self.supported_obligations),
            "critical": [],
            "extensions": {},
        }
        if spaces is not None:
            body["spaces"] = list(spaces)
        return self._request(f"{self.base_url}/context-packs", method="POST", body=body)

    def get_revision(self, space_id: str, revision_id: str, purpose: str) -> Mapping[str, Any]:
        obligations = base64.urlsafe_b64encode(
            json.dumps(
                self.supported_obligations,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode()
        ).decode().rstrip("=")
        path = f"{self.base_url}/spaces/{quote(space_id, safe='')}/revisions/{quote(revision_id, safe='')}"
        revision, response_headers = self._request_response(
            path,
            headers={"AKEP-Purpose": purpose, "AKEP-Obligation-Support": obligations},
        )
        exposure_receipt_id = response_headers.get("AKEP-Read-Receipt")
        if exposure_receipt_id is None:
            raise AKEPError(
                502,
                "AKEP_RECEIPT_MISSING",
                "The AKEP node returned a Revision without a read Exposure Receipt.",
            )
        exposure_receipt = self._request(
            f"{self.base_url}/exposure-receipts/{quote(exposure_receipt_id, safe='')}"
        )
        result: dict[str, Any] = {
            "revision": revision,
            "exposureReceipt": exposure_receipt,
            "exposureReceiptId": exposure_receipt_id,
        }
        quality_decision = response_headers.get("AKEP-Quality-Decision")
        quality_attestation = response_headers.get("AKEP-Quality-Attestation")
        if quality_decision is not None:
            result["qualityDecision"] = quality_decision
        if quality_attestation is not None:
            result["qualityAttestation"] = quality_attestation
        return result

    def record_usage(self, usage: Mapping[str, Any]) -> Mapping[str, Any]:
        return self._request(
            f"{self.base_url}/usages",
            method="POST",
            body={"akepVersion": "0.1", "critical": [], "extensions": {}, **usage},
            idempotency_key=f"sdk-usage-{uuid.uuid4()}",
        )

    def record_feedback(self, feedback: Mapping[str, Any]) -> Mapping[str, Any]:
        return self._request(
            f"{self.base_url}/feedback",
            method="POST",
            body={"akepVersion": "0.1", "critical": [], "extensions": {}, **feedback},
            idempotency_key=f"sdk-feedback-{uuid.uuid4()}",
        )

    def contribute(self, contribution: Mapping[str, Any]) -> Mapping[str, Any]:
        """Submit a governed candidate; this method never publishes it."""
        return self._request(
            f"{self.base_url}/contributions",
            method="POST",
            body=contribution,
            idempotency_key=f"sdk-contribution-{uuid.uuid4()}",
        )

    def _request(
        self,
        url: str,
        *,
        method: str = "GET",
        body: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        idempotency_key: str | None = None,
        authenticated: bool = True,
    ) -> Mapping[str, Any]:
        return self._request_response(
            url,
            method=method,
            body=body,
            headers=headers,
            idempotency_key=idempotency_key,
            authenticated=authenticated,
        )[0]

    def _request_response(
        self,
        url: str,
        *,
        method: str = "GET",
        body: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        idempotency_key: str | None = None,
        authenticated: bool = True,
    ) -> tuple[Mapping[str, Any], Mapping[str, str]]:
        request_headers = {"Accept": "application/json", "AKEP-Version": "0.1", **(headers or {})}
        if authenticated:
            token = self.token() if callable(self.token) else self.token
            request_headers["Authorization"] = f"Bearer {token}"
        if idempotency_key is not None:
            request_headers["Idempotency-Key"] = idempotency_key
        data = None
        if body is not None:
            request_headers["Content-Type"] = "application/json"
            data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
        request = Request(url, data=data, headers=request_headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return json.loads(response.read()), response.headers
        except HTTPError as error:
            try:
                problem = json.loads(error.read())
            except (json.JSONDecodeError, UnicodeDecodeError):
                problem = {}
            raise AKEPError(
                error.code,
                problem.get("code", "AKEP_HTTP_ERROR"),
                problem.get("detail")
                or problem.get("title")
                or f"AKEP request failed ({error.code})",
                problem.get("traceId"),
            ) from error
