"""Sandboxed execution of candidate programs for code benchmarks.

Follows the official HumanEval evaluation semantics (Chen et al., 2021):
a candidate passes iff `prompt-completion + test + check(entry_point)` runs to
completion within the timeout (official default 3.0 s per problem).

Execution model: each program runs in a fresh `python3 -I` subprocess with
POSIX rlimits (CPU seconds, address space, file size, no core dumps), a
wall-clock timeout, an empty environment, and cwd in a throwaway temp dir.
This is the same subprocess-isolation approach the official repos ship;
as they warn, generated code is untrusted — run full evaluations inside a
container or VM without secrets on it (docs/METHODOLOGY.md §sandboxing).
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile

_PRELUDE = """\
import resource, sys
resource.setrlimit(resource.RLIMIT_CPU, ({cpu}, {cpu}))
resource.setrlimit(resource.RLIMIT_AS, ({mem}, {mem}))
resource.setrlimit(resource.RLIMIT_FSIZE, (1_000_000, 1_000_000))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
sys.setrecursionlimit(10_000)
"""


def run_program(program: str, *, timeout_s: float = 3.0,
                mem_bytes: int = 1 << 31) -> dict:
    """Execute an assembled test program. Returns {passed, status, detail}."""
    cpu = max(int(timeout_s) + 1, 2)
    source = _PRELUDE.format(cpu=cpu, mem=mem_bytes) + "\n" + program
    with tempfile.TemporaryDirectory(prefix="aqeval-exec-") as td:
        path = os.path.join(td, "candidate.py")
        with open(path, "w", encoding="utf-8") as f:
            f.write(source)
        try:
            proc = subprocess.run(
                [sys.executable, "-I", path],
                cwd=td,
                env={"PATH": "/usr/bin:/bin"},
                capture_output=True,
                text=True,
                timeout=timeout_s + 2.0,  # wall clock guard above CPU rlimit
            )
        except subprocess.TimeoutExpired:
            return {"passed": False, "status": "timeout",
                    "detail": f"wall-clock timeout after {timeout_s + 2.0:.1f}s"}
        if proc.returncode == 0:
            return {"passed": True, "status": "passed", "detail": ""}
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        return {"passed": False, "status": "failed",
                "detail": detail[-1][:400] if detail else f"exit {proc.returncode}"}
