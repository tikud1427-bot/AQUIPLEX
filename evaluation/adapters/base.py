"""Model adapter interface. Every system under evaluation implements generate()."""
from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class ModelResponse:
    text: str
    latency_ms: float
    raw: dict = field(default_factory=dict)   # full provider payload, stored verbatim
    meta: dict = field(default_factory=dict)  # adapter-specific diagnostics (provider, fallback chain, …)


class ModelAdapter:
    """Provider-agnostic adapter. Subclasses translate a single prompt into one
    request against the system under evaluation and return the raw response.

    The framework never post-processes model behaviour here — extraction and
    scoring live in scoring/, so adapters stay a pure transport layer."""

    type_name = "base"

    def __init__(self, config: dict):
        self.config = config
        self.name = config.get("name", self.type_name)

    # -- required -----------------------------------------------------------
    def generate(self, prompt: str, *, max_tokens: int | None = None,
                 stop: list[str] | None = None) -> ModelResponse:
        raise NotImplementedError

    # -- optional -----------------------------------------------------------
    def healthcheck(self) -> tuple[bool, str]:
        return True, "no healthcheck implemented"

    def describe(self) -> dict:
        redacted = {k: v for k, v in self.config.items() if "key" not in k.lower()}
        return {"type": self.type_name, **redacted}

    # -- helper -------------------------------------------------------------
    @staticmethod
    def _timed(fn):
        t0 = time.perf_counter()
        out = fn()
        return out, (time.perf_counter() - t0) * 1000.0
