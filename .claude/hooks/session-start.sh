#!/bin/bash
# Make the Homey CLI available in cloud sessions. `homey app validate` is the release gate
# (see CLAUDE.md), so a session without it can't check an app.json change.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if ! command -v homey >/dev/null 2>&1; then
  npm install -g homey
fi
