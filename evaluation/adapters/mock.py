"""Deterministic mock adapter.

Exists ONLY so `aqeval selftest` can exercise the full pipeline
(prompting → transport → capture → scoring → reports) without a live model.

It answers every prompt with a fixed non-answer, so scores are ~0 by design.
Runs made with it are stamped adapter_type="mock", forced official=false, and
every report carries a MOCK banner. It can never be mistaken for, or used to
produce, a real AQUA benchmark result — that would violate the framework's
no-fabrication rule.
"""
from __future__ import annotations

import hashlib

from .base import ModelAdapter, ModelResponse


class MockAdapter(ModelAdapter):
    type_name = "mock"

    def generate(self, prompt: str, *, max_tokens=None, stop=None) -> ModelResponse:
        digest = hashlib.sha256(prompt.encode()).hexdigest()[:8]
        text = (
            "[mock-selftest] This is a deterministic placeholder response used to "
            f"verify AQEval plumbing (prompt digest {digest}). It intentionally "
            "contains no answer."
        )
        return ModelResponse(text=text, latency_ms=0.1, raw={"mock": True},
                             meta={"digest": digest})

    def healthcheck(self):
        return True, "mock adapter always healthy"
