"""Adapter for AQUA (Aquiplex).

Speaks the real engine contract — POST {base_url}/chat with
    { "message": "<prompt>" }
and reads the documented success payload
    { success, requestId, conversationId, answer, provider, providerScore,
      taskType, confidence, latencyMs, fallbackChain, truncated, finishReason, … }
(see aqua/src/routes/chat.js, buildResponsePayload).

Isolation: every benchmark item is sent WITHOUT a conversationId, so the engine
creates a fresh conversation per item — no cross-item history, memory, or
attachment leakage between questions.

Two deployment targets, same adapter:
  1. Standalone harness (recommended): runners/aqua-standalone.mjs mounts
     aqua/router.js sessionless on 127.0.0.1:8877 with an isolated
     AQUA_DATA_DIR. No login, no credit metering, prod data untouched.
  2. Deployed platform: set base_url to https://<host>/api/aqua and add a
     logged-in session cookie via config.headers.Cookie. Note that the
     platform meters credits on POST /chat (usageGuard in index.js).

Decoding note: AQUA owns its own provider routing, temperature, and token
budgets internally; the adapter cannot set them per request. Runs therefore
record engine-side flags (AQUA_CIE / AQUA_PIC / AQUA_GRAPH, search key
presence) in the manifest instead of sampler params.
"""
from __future__ import annotations

from ..core.common import HttpError, http_json
from .base import ModelAdapter, ModelResponse


class AquiplexAdapter(ModelAdapter):
    type_name = "aquiplex"

    def __init__(self, config: dict):
        super().__init__(config)
        self.base_url = config["base_url"].rstrip("/")
        self.timeout_s = float(config.get("timeout_s", 180))
        self.max_retries = int(config.get("max_retries", 3))
        self.backoff = float(config.get("retry_backoff_s", 2.0))
        self.headers = dict(config.get("headers", {}))

    def generate(self, prompt: str, *, max_tokens=None, stop=None) -> ModelResponse:
        # max_tokens / stop are recorded by the runner but cannot be forwarded:
        # the engine's public chat contract accepts only message/conversationId/
        # workspaceId. This is a documented limitation (docs/LIMITATIONS.md).
        def call():
            return http_json(
                f"{self.base_url}/chat",
                method="POST",
                payload={"message": prompt},
                headers=self.headers,
                timeout_s=self.timeout_s,
                max_retries=self.max_retries,
                retry_backoff_s=self.backoff,
            )

        data, latency_ms = self._timed(call)
        if not data.get("success"):
            raise HttpError(200, f"engine returned success=false: {data.get('error')}", self.base_url)
        return ModelResponse(
            text=data.get("answer", "") or "",
            latency_ms=latency_ms,
            raw=data,
            meta={
                "provider": data.get("provider"),
                "providerScore": data.get("providerScore"),
                "taskType": data.get("taskType"),
                "engineConfidence": data.get("confidence"),
                "fallbackChain": data.get("fallbackChain"),
                "truncated": data.get("truncated"),
                "finishReason": data.get("finishReason"),
                "engineLatencyMs": data.get("latencyMs"),
                "conversationId": data.get("conversationId"),
            },
        )

    def healthcheck(self) -> tuple[bool, str]:
        try:
            data = http_json(f"{self.base_url}/provider-health", timeout_s=15, max_retries=0)
            return True, f"provider-health ok ({len(data) if hasattr(data, '__len__') else 'ok'})"
        except Exception as e:  # noqa: BLE001
            return False, (
                f"AQUA not reachable at {self.base_url} — start the standalone harness first:\n"
                f"    node evaluation/runners/aqua-standalone.mjs\n({e})"
            )
