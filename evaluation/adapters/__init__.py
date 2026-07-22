from __future__ import annotations

from pathlib import Path

from ..core.common import load_json
from .aquiplex import AquiplexAdapter
from .base import ModelAdapter, ModelResponse
from .mock import MockAdapter
from .providers import AnthropicAdapter, OpenAICompatAdapter

_REGISTRY = {
    "aquiplex": AquiplexAdapter,
    "openai_compat": OpenAICompatAdapter,
    "anthropic": AnthropicAdapter,
    "mock": MockAdapter,
}


def create_adapter(config_path: str | Path) -> ModelAdapter:
    config = load_json(Path(config_path))
    t = config.get("type")
    if t not in _REGISTRY:
        raise ValueError(f"Unknown adapter type '{t}'. Known: {sorted(_REGISTRY)}")
    return _REGISTRY[t](config)


__all__ = ["ModelAdapter", "ModelResponse", "create_adapter"]
