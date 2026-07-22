"""OpenAI-compatible façade over any AQEval adapter.

Purpose: run the OFFICIAL external harnesses against AQUA without touching
their code — lm-evaluation-harness, EvalPlus, LiveCodeBench, lmms-eval and
most others speak `POST /v1/chat/completions`. Point them here; the shim
forwards each request to the configured adapter (normally AQUA) verbatim.

    python3 evaluation/aqeval.py shim --adapter evaluation/configs/adapters/aquiplex.json
    lm_eval --model local-chat-completions \\
        --model_args model=aqua,base_url=http://127.0.0.1:8799/v1/chat/completions,num_concurrent=4,tokenized_requests=False \\
        --tasks mmlu --output_path evaluation/reports/harness/

Stdlib only; threads per request; no auth (bind localhost only).
"""
from __future__ import annotations

import json
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .base import ModelAdapter


def serve(adapter: ModelAdapter, host: str = "127.0.0.1", port: int = 8799) -> None:
    class Handler(BaseHTTPRequestHandler):
        server_version = "AQEvalShim/1.0"

        def log_message(self, fmt, *args):  # quiet default; errors still raise
            pass

        def _json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/v1/models":
                self._json(200, {"object": "list",
                                 "data": [{"id": adapter.name, "object": "model"}]})
            else:
                self._json(404, {"error": {"message": "not found"}})

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", 0))
                req = json.loads(self.rfile.read(length) or b"{}")
                if self.path == "/v1/chat/completions":
                    prompt = "\n\n".join(
                        m.get("content", "") if isinstance(m.get("content"), str)
                        else "\n".join(p.get("text", "") for p in m.get("content", [])
                                       if isinstance(p, dict))
                        for m in req.get("messages", []))
                elif self.path == "/v1/completions":
                    prompt = req.get("prompt", "")
                    if isinstance(prompt, list):
                        prompt = prompt[0]
                else:
                    return self._json(404, {"error": {"message": "unknown route"}})

                resp = adapter.generate(prompt,
                                        max_tokens=req.get("max_tokens"),
                                        stop=req.get("stop"))
                now = int(time.time())
                if self.path == "/v1/chat/completions":
                    payload = {
                        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
                        "object": "chat.completion", "created": now,
                        "model": adapter.name,
                        "choices": [{"index": 0,
                                     "message": {"role": "assistant", "content": resp.text},
                                     "finish_reason": resp.meta.get("finishReason") or "stop"}],
                        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                        "aqeval_meta": resp.meta,
                    }
                else:
                    payload = {
                        "id": f"cmpl-{uuid.uuid4().hex[:24]}",
                        "object": "text_completion", "created": now,
                        "model": adapter.name,
                        "choices": [{"index": 0, "text": resp.text,
                                     "finish_reason": resp.meta.get("finishReason") or "stop"}],
                        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                    }
                self._json(200, payload)
            except Exception as e:  # noqa: BLE001 — surface as OpenAI-style error
                self._json(500, {"error": {"message": str(e), "type": "aqeval_shim_error"}})

    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"AQEval shim: OpenAI-compatible endpoint for '{adapter.name}' "
          f"on http://{host}:{port}/v1  (Ctrl-C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
