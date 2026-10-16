#!/bin/sh
# Launches the Playwright MCP server for Claude Code (see .mcp.json).
# In Claude Code cloud containers, Chromium is preinstalled at
# /opt/pw-browsers/chromium and there is no display, so run it headless
# against that binary. Elsewhere, use @playwright/mcp's defaults (local Chrome).
set -eu
PW_CHROMIUM=/opt/pw-browsers/chromium
if [ -x "$PW_CHROMIUM" ]; then
  exec npx -y @playwright/mcp@0.0.83 --browser chromium \
    --executable-path "$PW_CHROMIUM" --headless --no-sandbox --isolated "$@"
fi
exec npx -y @playwright/mcp@0.0.83 "$@"
