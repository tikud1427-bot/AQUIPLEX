"""Comparison-mode adapters. Provider-agnostic by construction:

  * openai_compat — any endpoint speaking POST /chat/completions
    (OpenAI, Google Gemini's OpenAI-compat surface, vLLM / llama.cpp /
    Ollama / TGI serving open-weight models, OpenRouter, Together, …)
  * anthropic — POST /messages

Nothing provider-specific is hardcoded beyond these two public wire formats;
model name, base URL, and key env var all come from the adapter config file.
"""
from __future__ import annotations

import os

from ..core.common import http_json
from .base import ModelAdapter, ModelResponse


def _key(config: dict) -> str:
    env = config.get("api_key_env", "")
    key = os.environ.get(env, "")
    if not key:
        raise RuntimeError(
            f"Adapter '{config.get('name')}' needs an API key in ${env} (not set)."
        )
    return key


class OpenAICompatAdapter(ModelAdapter):
    type_name = "openai_compat"

    def generate(self, prompt: str, *, max_tokens=None, stop=None) -> ModelResponse:
        c = self.config
        payload = {
            "model": c["model"],
            "messages": [{"role": "user", "content": prompt}],
            "temperature": c.get("temperature", 0.0),
            "max_tokens": max_tokens or c.get("max_tokens", 2048),
        }
        if stop:
            payload["stop"] = stop

        def call():
            return http_json(
                f"{c['base_url'].rstrip('/')}/chat/completions",
                method="POST",
                payload=payload,
                headers={"Authorization": f"Bearer {_key(c)}"},
                timeout_s=c.get("timeout_s", 120),
                max_retries=c.get("max_retries", 3),
                retry_backoff_s=c.get("retry_backoff_s", 2.0),
            )

        data, latency_ms = self._timed(call)
        choice = (data.get("choices") or [{}])[0]
        return ModelResponse(
            text=(choice.get("message") or {}).get("content", "") or "",
            latency_ms=latency_ms,
            raw=data,
            meta={"finish_reason": choice.get("finish_reason"),
                  "usage": data.get("usage")},
        )


class AnthropicAdapter(ModelAdapter):
    type_name = "anthropic"

    def generate(self, prompt: str, *, max_tokens=None, stop=None) -> ModelResponse:
        c = self.config
        payload = {
            "model": c["model"],
            "max_tokens": max_tokens or c.get("max_tokens", 2048),
            "temperature": c.get("temperature", 0.0),
            "messages": [{"role": "user", "content": prompt}],
        }
        if stop:
            payload["stop_sequences"] = stop

        def call():
            return http_json(
                f"{c['base_url'].rstrip('/')}/messages",
                method="POST",
                payload=payload,
                headers={"x-api-key": _key(c), "anthropic-version": "2023-06-01"},
                timeout_s=c.get("timeout_s", 120),
                max_retries=c.get("max_retries", 3),
                retry_backoff_s=c.get("retry_backoff_s", 2.0),
            )

        data, latency_ms = self._timed(call)
        text = "".join(b.get("text", "") for b in data.get("content", [])
                       if b.get("type") == "text")
        return ModelResponse(
            text=text,
            latency_ms=latency_ms,
            raw=data,
            meta={"stop_reason": data.get("stop_reason"), "usage": data.get("usage")},
        )
