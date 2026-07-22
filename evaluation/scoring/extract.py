"""Answer extraction from model output.

Each benchmark declares which extractor(s) it uses; extraction rules follow the
reference implementations cited in docs/METHODOLOGY.md. Both a strict and a
flexible extraction are reported for GSM8K, mirroring lm-evaluation-harness's
strict-match / flexible-extract pair, so numbers are comparable either way.
"""
from __future__ import annotations

import re

_NUM = r"-?\$?[\d,]*\.?\d+"


def _norm_number(s: str) -> str | None:
    s = s.strip().rstrip(".").replace(",", "").replace("$", "").replace("%", "")
    if not s:
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    if f == int(f):
        return str(int(f))
    return repr(f)


def numbers_equal(a: str | None, b: str | None) -> bool:
    if a is None or b is None:
        return False
    na, nb = _norm_number(a), _norm_number(b)
    if na is None or nb is None:
        return False
    try:
        return abs(float(na) - float(nb)) < 1e-6
    except ValueError:
        return na == nb


def extract_answer_is(text: str) -> str | None:
    """Strict GSM8K extraction: final 'The answer is X' (CoT exemplar format)."""
    matches = re.findall(rf"[Tt]he answer is\s*:?\s*({_NUM})", text)
    return matches[-1] if matches else None


def extract_last_number(text: str) -> str | None:
    """Flexible extraction: last number anywhere in the response."""
    matches = re.findall(_NUM, text)
    return matches[-1] if matches else None


def extract_hash_answer(text: str) -> str | None:
    """GSM8K gold format: '#### 42'."""
    m = re.search(rf"####\s*({_NUM})", text)
    return m.group(1) if m else None


def extract_mc_letter(text: str, letters: str = "ABCD") -> str | None:
    """Multiple-choice letter extraction, most-specific pattern first."""
    ls = f"[{letters}]"
    patterns = [
        rf"answer is\s*:?\s*\(?({ls})\)?",
        rf"[Aa]nswer\s*:\s*\(?({ls})\)?",
        rf"\(({ls})\)\s*is\s+correct",
        rf"^\s*\(?({ls})\)?[.):\s]",
    ]
    for p in patterns:
        m = re.search(p, text, re.MULTILINE)
        if m:
            return m.group(1)
    # last resort: final standalone capital letter in range
    matches = re.findall(rf"\b({ls})\b", text)
    return matches[-1] if matches else None


def last_boxed_only_string(text: str) -> str | None:
    """Return the last \\boxed{...} (or \\fbox) content, brace-balanced.
    Port of the extraction in the official MATH grading code
    (hendrycks/math, MIT licence)."""
    idx = text.rfind("\\boxed")
    if idx < 0:
        idx = text.rfind("\\fbox")
        if idx < 0:
            return None
    i = text.find("{", idx)
    if i < 0:
        return None
    depth = 0
    for j in range(i, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return text[i + 1 : j]
    return None


def extract_code_block(text: str) -> str | None:
    """Prefer the largest fenced code block; fall back to raw text heuristics."""
    fences = re.findall(r"```(?:python|py)?\s*\n(.*?)```", text, re.DOTALL)
    if fences:
        return max(fences, key=len).strip("\n")
    return None
