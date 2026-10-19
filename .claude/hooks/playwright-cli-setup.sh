#!/bin/sh
# SessionStart hook: make playwright-cli usable in Claude Code cloud containers.
# Cloud containers ship Chromium at /opt/pw-browsers/chromium, have no display,
# and start each session without global npm installs. Elsewhere this does nothing,
# so playwright-cli keeps its defaults (local Chrome) on developer machines.
PW_CHROMIUM=/opt/pw-browsers/chromium
[ -x "$PW_CHROMIUM" ] || exit 0

if ! command -v playwright-cli >/dev/null 2>&1; then
  npm install -g @playwright/cli@0.1.22 >/dev/null 2>&1 || exit 0
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  cat >> "$CLAUDE_ENV_FILE" <<ENV
export PLAYWRIGHT_MCP_BROWSER=chromium
export PLAYWRIGHT_MCP_EXECUTABLE_PATH=$PW_CHROMIUM
export PLAYWRIGHT_MCP_HEADLESS=true
export PLAYWRIGHT_MCP_NO_SANDBOX=true
ENV
fi
exit 0
