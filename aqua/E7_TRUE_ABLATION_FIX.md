# E7 True Lane Ablation Fix

The ablation adapter now keeps the PIC floor lexical-only. Semantic scores are
passed to the Context Engine separately, allowing the dense proposal lane to
introduce candidates independently. This prevents the dense configuration from
silently measuring PIC lexical+dense.

Production code is unchanged by this eval-only isolation correction.
