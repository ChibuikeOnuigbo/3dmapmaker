#!/usr/bin/env bash
# Panorama Maps — desktop launcher (Linux)
# Double-click in your file manager, or run:  bash desktop/start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Panorama Maps needs Node.js (18 or newer) — https://nodejs.org"
  echo "Press Enter to close."
  read -r _
  exit 1
fi
exec node --no-warnings=ExperimentalWarning main.mjs "$@"
