#!/usr/bin/env bash
# E1/PR-7 — remove the two snapshot copies. Refuses if anything but the hygiene test references them.
set -euo pipefail
for f in aqua/src/brain/understanding/pipeline.before-pr17.js e6Extractor-before-pr16.mjs; do
  base=$(basename "$f")
  if grep -rIl --exclude-dir=node_modules --exclude=repoHygiene.test.js --exclude=*.md --exclude=*.sh -F "$base" . 2>/dev/null | grep -q .; then
    echo "REFUSING: $base is referenced elsewhere"; exit 1; fi
  [ -e "$f" ] && rm -v "$f" || echo "already gone: $f"
done
