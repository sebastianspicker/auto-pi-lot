#!/usr/bin/env bash
# Claude Code Stop hook: runs `npm run check` before letting a session stop.
# Reads the hook JSON payload from stdin; exits 0 to allow stopping, 2 to block
# (Claude Code then reads stderr as feedback and continues instead of stopping).
set -uo pipefail

INPUT="$(cat)"

STOP_HOOK_ACTIVE="$(node -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(data);
    process.stdout.write(parsed.stop_hook_active ? "true" : "false");
  } catch {
    process.stdout.write("false");
  }
});
' <<<"$INPUT")"

# stop_hook_active is true when this same Stop hook already ran for the
# current stop attempt; exiting 0 here prevents an infinite check-fail loop.
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Use the path's real on-disk casing. On case-insensitive file systems a session started
# from, say, ~/projects instead of ~/Projects makes TypeScript see every file twice.
REPO_ROOT="$(node -e 'process.stdout.write(require("fs").realpathSync.native(process.argv[1]))' "$REPO_ROOT")"
cd "$REPO_ROOT" || exit 2

OUTPUT="$(npm run check 2>&1)"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  echo "npm run check failed (exit $STATUS); last 40 lines:" >&2
  echo "$OUTPUT" | tail -n 40 >&2
  exit 2
fi

exit 0
