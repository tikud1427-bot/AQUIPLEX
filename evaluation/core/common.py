"""AQEval core utilities. Python stdlib only — zero third-party dependencies."""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

EVAL_ROOT = Path(__file__).resolve().parent.parent          # evaluation/
REPO_ROOT = EVAL_ROOT.parent                                # platform root
CACHE_DIR = EVAL_ROOT / "datasets" / "cache"
RUNS_DIR = EVAL_ROOT / "reports" / "runs"

USER_AGENT = "AQEval/1.0 (+https://aquiplex.example; benchmark harness)"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_jsonl(path: Path) -> list[dict]:
    opener = gzip.open if str(path).endswith(".gz") else open
    out = []
    with opener(path, "rt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def write_jsonl(path: Path, rows) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def append_jsonl(path: Path, row: dict) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def load_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, obj) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")


class HttpError(RuntimeError):
    def __init__(self, status: int, body: str, url: str):
        super().__init__(f"HTTP {status} from {url}: {body[:300]}")
        self.status = status
        self.body = body


def http_request(
    url: str,
    method: str = "GET",
    payload: dict | None = None,
    headers: dict | None = None,
    timeout_s: float = 120,
    max_retries: int = 3,
    retry_backoff_s: float = 2.0,
) -> tuple[int, bytes]:
    """HTTP with exponential-backoff retries on 429/5xx and transport errors."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    hdrs = {"User-Agent": USER_AGENT}
    if payload is not None:
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})

    last_err: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
            with urllib.request.urlopen(req, timeout=timeout_s) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            if e.code in (408, 429, 500, 502, 503, 504) and attempt < max_retries:
                time.sleep(retry_backoff_s * (2 ** attempt))
                last_err = HttpError(e.code, body, url)
                continue
            raise HttpError(e.code, body, url) from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            if attempt < max_retries:
                time.sleep(retry_backoff_s * (2 ** attempt))
                last_err = e
                continue
            raise
    raise last_err  # pragma: no cover


def http_json(url: str, **kw) -> dict:
    status, body = http_request(url, **kw)
    return json.loads(body.decode("utf-8"))


def download(url: str, dest: Path, expected_sha256: str | None = None) -> Path:
    """Download url → dest. Verifies checksum when one is pinned."""
    ensure_dir(dest.parent)
    if dest.exists() and (expected_sha256 is None or sha256_file(dest) == expected_sha256):
        return dest
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=300) as resp, open(tmp, "wb") as f:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    if expected_sha256 is not None:
        got = sha256_file(tmp)
        if got != expected_sha256:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(
                f"Checksum mismatch for {url}\n  expected {expected_sha256}\n  got      {got}\n"
                "Refusing to use the file — the upstream dataset may have changed."
            )
    os.replace(tmp, dest)
    return dest


def env_flag_snapshot() -> dict:
    """Record AQUA behaviour flags and which provider keys are configured.
    Values of secrets are never recorded — presence booleans only."""
    flags = {}
    for k in ("AQUA_CIE", "AQUA_PIC", "AQUA_GRAPH", "AQUA_EMBEDDINGS", "AQUA_DATA_DIR",
              "AQUA_DISABLE_MONGO_MIRROR", "ARTIFACTS_ENABLED", "NODE_ENV"):
        if k in os.environ:
            flags[k] = os.environ[k]
    key_presence = {}
    for k in ("GROQ_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "TOGETHER_API_KEY",
              "HF_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY", "OPENAI_API_KEY",
              "ANTHROPIC_API_KEY"):
        key_presence[k] = bool(os.environ.get(k))
    return {"aqua_flags": flags, "provider_keys_present": key_presence}
