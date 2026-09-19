#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/build/session-bots-checks"
mkdir -p "$OUT"
SRC="$ROOT/app/src/main/java/com/example/launcherprobe"
javac -encoding UTF-8 -d "$OUT" "$SRC/BotMailbox.java" "$SRC/BotMailboxFile.java" "$SRC/BotPolicy.java" \
  "$ROOT/tests/com/example/launcherprobe/BotMailboxChecks.java"
java -cp "$OUT" com.example.launcherprobe.BotMailboxChecks
node "$ROOT/scripts/check-bot-protocol.mjs"
