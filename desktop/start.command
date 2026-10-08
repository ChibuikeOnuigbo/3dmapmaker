#!/usr/bin/env bash
# Panorama Maps — desktop launcher (macOS)
# Double-click in Finder (first time: right-click → Open), or run: bash desktop/start.command
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Panorama Maps needs Node.js (18 or newer) — https://nodejs.org"
  echo "Press Enter to close."
  read -r _
  exit 1
fi
exec node --no-warnings=ExperimentalWarning main.mjs "$@"
