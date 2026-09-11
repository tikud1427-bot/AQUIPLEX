E7 V3 candidate-pool fix

Problem:
Retrieval V3 was asking PIC for only the final output limit (8). PIC therefore
returned only its top 8 items before Context Engine/RRF could see independent
dense candidates. The dense improvement (79.8% recall@8) was consequently
truncated before V3 fusion.

Fix:
When Context Engine V2 + Retrieval V3 are both active, ask PIC for a bounded
candidate pool of max(limit*4, 32), while the Context Engine assembler still
enforces the requested output limit. Ordinary V2 and V3-off behavior remains
unchanged.

Regression test:
Context Engine V3 must request 32 candidates for limit=8 and return <=8 items.

Apply from the repository root with:
tar -xzf .\aquiplex-e7-v3-pool-fix.tar.gz -C .
