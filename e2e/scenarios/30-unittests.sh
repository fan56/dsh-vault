#!/usr/bin/env bash
# Scenario 30 — the full unit suite re-run inside the clean container env
# (crypto, backup set boundary, manifest, command dispatch).
set -euo pipefail

cd /app
node --test test/crypto.test.mjs test/backupset.test.mjs test/manifest.test.mjs test/command.test.mjs \
  > /tmp/unittests.log 2>&1 \
  || { tail -40 /tmp/unittests.log; exit 1; }

grep -E '^. (tests|pass|fail)' /tmp/unittests.log
echo 'PASS 30-unittests'
