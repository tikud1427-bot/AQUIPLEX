"""Aggregate statistics.

pass@k uses the unbiased estimator from the HumanEval paper
(Chen et al., 2021, "Evaluating Large Language Models Trained on Code",
eq. in §2.1): pass@k = E[1 - C(n-c, k) / C(n, k)].

Confidence: binomial standard error plus a seeded nonparametric bootstrap
95% CI over per-item scores (reported as `confidence` in every report).
"""
from __future__ import annotations

import math
import random
from math import comb


def mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def binomial_stderr(p: float, n: int) -> float:
    if n <= 1:
        return 0.0
    return math.sqrt(max(p * (1 - p), 0.0) / n)


def bootstrap_ci(scores: list[float], iters: int = 1000, seed: int = 1234,
                 alpha: float = 0.05) -> tuple[float, float]:
    if not scores:
        return 0.0, 0.0
    rng = random.Random(seed)
    n = len(scores)
    means = sorted(mean([scores[rng.randrange(n)] for _ in range(n)])
                   for _ in range(iters))
    lo = means[int((alpha / 2) * iters)]
    hi = means[min(int((1 - alpha / 2) * iters), iters - 1)]
    return lo, hi


def pass_at_k(n: int, c: int, k: int) -> float:
    """Unbiased pass@k for one problem with n samples, c of which pass."""
    if n - c < k:
        return 1.0
    return 1.0 - comb(n - c, k) / comb(n, k)


def aggregate(scores: list[float], *, seed: int = 1234) -> dict:
    p = mean(scores)
    lo, hi = bootstrap_ci(scores, seed=seed)
    return {
        "n": len(scores),
        "mean": round(p, 6),
        "stderr": round(binomial_stderr(p, len(scores)), 6),
        "ci95": [round(lo, 6), round(hi, 6)],
    }
