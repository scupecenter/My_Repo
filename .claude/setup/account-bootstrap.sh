#!/usr/bin/env bash
# ===========================================================================
# Claude Code account bootstrap
# Rebuilds every skill / plugin / MCP into ~/.claude at session start, so they
# are available in ANY project using this environment. Idempotent & non-fatal:
# a single failed step never aborts session startup.
# Paste this into: cloud environment menu (session title bar) -> Edit -> Setup script.
# ===========================================================================
set -uo pipefail
SK="$HOME/.claude/skills"; AG="$HOME/.claude/agents"
mkdir -p "$SK" "$AG"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
[ -x /opt/pw-browsers/chromium ] && export CHROME_PATH=/opt/pw-browsers/chromium

# --- 0) Default model: opusplan (Opus for plan mode, Sonnet for execution) -
#     Merged into ~/.claude/settings.json, preserving any existing keys.
python3 -I - <<'PY_EOF' >/dev/null 2>&1 || true
import json, os
p = os.path.expanduser("~/.claude/settings.json")
try:
    with open(p) as f: cfg = json.load(f)
except Exception:
    cfg = {}
if not isinstance(cfg, dict): cfg = {}
cfg["model"] = "opusplan"
os.makedirs(os.path.dirname(p), exist_ok=True)
with open(p, "w") as f: json.dump(cfg, f, indent=2)
PY_EOF

# --- 1) Catalog plugins (user scope) --------------------------------------
claude plugin marketplace add anthropics/claude-plugins-official >/dev/null 2>&1 || true
for p in \
  claude-code-setup@claude-plugins-official \
  security-guidance@claude-plugins-official \
  headroom-large-file-and-log-reader@anthropic-plugin-directory \
  task-observer-learn-your-preferences@anthropic-plugin-directory \
  humanizer-blader@anthropic-plugin-directory ; do
  claude plugin install "$p" --scope user >/dev/null 2>&1 || true
done

# --- 2) MCP servers (user scope). API keys are read from env at launch. ----
claude mcp add firecrawl  -s user -e 'FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY}'   -- npx -y firecrawl-mcp@3.27.3            >/dev/null 2>&1 || true
claude mcp add perplexity -s user -e 'PERPLEXITY_API_KEY=${PERPLEXITY_API_KEY}' -- npx -y @perplexity-ai/mcp-server@1.3.0 >/dev/null 2>&1 || true
claude mcp add rea        -s user -- npx -y rea-agents@6.7.0 mcp                 >/dev/null 2>&1 || true
claude mcp add chrome-devtools -s user -- npx -y chrome-devtools-mcp@1.10.1 --executablePath /opt/pw-browsers/chromium --headless --isolated --chromeArg=--no-sandbox --performanceCrux=false --usageStatistics=false >/dev/null 2>&1 || true
if [ -x /opt/pw-browsers/chromium ]; then
  claude mcp add playwright -s user -- npx -y @playwright/mcp@0.0.83 --browser chromium \
    --executable-path /opt/pw-browsers/chromium --headless --no-sandbox --isolated >/dev/null 2>&1 || true
else
  claude mcp add playwright -s user -- npx -y @playwright/mcp@0.0.83 >/dev/null 2>&1 || true
fi

# --- 3) Vendored skills + agents + commands from your my_repo repo ---------
#     (impeccable, reverse-engineer-anything, playwright-cli, unlazy + impeccable
#      agents + the /security-review command). Needs GitHub access to the repo.
CMD="$HOME/.claude/commands"; mkdir -p "$CMD"
if git clone --depth 1 https://github.com/scupecenter/my_repo.git "$TMP/myrepo" >/dev/null 2>&1; then
  for s in impeccable reverse-engineer-anything playwright-cli unlazy ; do
    [ -d "$TMP/myrepo/.claude/skills/$s" ] && { rm -rf "$SK/$s"; cp -R "$TMP/myrepo/.claude/skills/$s" "$SK/$s"; }
  done
  for a in "$TMP/myrepo/.claude/agents/"impeccable-*.md ; do [ -f "$a" ] && cp "$a" "$AG/"; done
  for c in "$TMP/myrepo/.claude/commands/"*.md ; do [ -f "$c" ] && cp "$c" "$CMD/"; done
fi

# --- 4) OmniRoute skill set (45 skills + ponytail + config-codex-cli) ------
if git clone --depth 1 https://github.com/diegosouzapw/OmniRoute.git "$TMP/omni" >/dev/null 2>&1; then
  for d in "$TMP/omni/skills"/*/ ; do n="$(basename "$d")"; rm -rf "$SK/$n"; cp -R "$d" "$SK/$n"; done
fi


# --- 5) grill-me + grilling (Matt Pocock, MIT) from upstream ---------------
if git clone --depth 1 https://github.com/mattpocock/skills.git "$TMP/mp" >/dev/null 2>&1; then
  for s in grill-me grilling ; do
    d="$(find "$TMP/mp/skills" -type d -name "$s" | head -1)"
    [ -n "$d" ] && { rm -rf "${SK:?}/$s"; cp -R "$d" "$SK/$s"; }
  done
fi

# --- 6) karpathy-guidelines (MIT) from upstream ----------------------------
if git clone --depth 1 https://github.com/multica-ai/andrej-karpathy-skills.git "$TMP/kp" >/dev/null 2>&1; then
  [ -d "$TMP/kp/skills/karpathy-guidelines" ] && { rm -rf "${SK:?}/karpathy-guidelines"; cp -R "$TMP/kp/skills/karpathy-guidelines" "$SK/karpathy-guidelines"; }
fi

# --- 7) find-skills (Vercel Labs, MIT) from upstream -----------------------
if git clone --depth 1 https://github.com/vercel-labs/skills.git "$TMP/vl" >/dev/null 2>&1; then
  [ -d "$TMP/vl/skills/find-skills" ] && { rm -rf "${SK:?}/find-skills"; cp -R "$TMP/vl/skills/find-skills" "$SK/find-skills"; }
fi

# --- 8) taste-skill / design-taste-frontend (Leonxlnx, MIT) ----------------
#     Needs Node 22+ and CHROME_PATH for its inspect/draw scripts.
if git clone --depth 1 https://github.com/Leonxlnx/taste-skill.git "$TMP/ts" >/dev/null 2>&1; then
  [ -d "$TMP/ts/skills/taste-skill" ] && { rm -rf "${SK:?}/taste-skill"; cp -R "$TMP/ts/skills/taste-skill" "$SK/taste-skill"; }
fi

# --- 9) ui-ux-pro-max (Next Level Builder, MIT) — local-data UI/UX intel -----
if git clone --depth 1 https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git "$TMP/ux" >/dev/null 2>&1; then
  [ -d "$TMP/ux/.claude/skills/ui-ux-pro-max" ] && { rm -rf "${SK:?}/ui-ux-pro-max"; cp -R "$TMP/ux/.claude/skills/ui-ux-pro-max" "$SK/ui-ux-pro-max"; }
fi

# --- 10) awesome-design-md brand reference pack (VoltAgent, MIT) -----------
if git clone --depth 1 https://github.com/VoltAgent/awesome-design-md.git "$TMP/ad" >/dev/null 2>&1; then
  D="$SK/awesome-design-md"; rm -rf "${D:?}"; mkdir -p "$D"
  cp -R "$TMP/ad/design-md" "$D/design-md"
  cp "$TMP/ad/README.md" "$D/COLLECTION-README.md" 2>/dev/null || true
  cp "$TMP/ad/LICENSE" "$D/LICENSE" 2>/dev/null || true
  cat > "$D/SKILL.md" <<'SK_EOF'
---
name: awesome-design-md
description: A reference library of real-brand design systems as DESIGN.md specs (Apple, Linear, Notion, Vercel, Raycast, Tesla, and more), from VoltAgent/awesome-design-md (MIT). Use when establishing or matching a visual direction, picking a design language, or grounding UI work in a concrete, named aesthetic rather than generic defaults. Each brand folder under design-md/ holds its DESIGN.md.
---

# Awesome Design MD — brand design-system reference

A curated library of real-brand design systems, each a DESIGN.md. Source:
VoltAgent/awesome-design-md (MIT). This SKILL.md is a thin index added at
install time; the brand files are the upstream collection, unchanged.
Browse with: ls <skill-dir>/design-md/ ; read the closest brand's DESIGN.md and
apply its tokens/principles (adapt, never copy trademarked names/assets).
SK_EOF
fi

# --- 11) design-motion-principles (Kyle Zantos, MIT) -----------------------
if git clone --depth 1 https://github.com/kylezantos/design-motion-principles.git "$TMP/mo" >/dev/null 2>&1; then
  [ -d "$TMP/mo/skills/design-motion-principles" ] && { rm -rf "${SK:?}/design-motion-principles"; cp -R "$TMP/mo/skills/design-motion-principles" "$SK/design-motion-principles"; }
fi

# --- 12) Scrapling: library + MCP server (social/web scraping, no API key) --
#     HTTP tools work immediately; browser tools use the container Chromium.
command -v uv >/dev/null 2>&1 && uv tool install "scrapling[ai]==0.5" >/dev/null 2>&1 || true
if command -v scrapling-mcp >/dev/null 2>&1; then
  if [ -x /opt/pw-browsers/chromium ]; then
    claude mcp add scrapling -s user -- "$HOME/.local/bin/scrapling-mcp" \
      --executable-path /opt/pw-browsers/chromium >/dev/null 2>&1 || true
  else
    claude mcp add scrapling -s user -- "$HOME/.local/bin/scrapling-mcp" >/dev/null 2>&1 || true
  fi
fi

# --- 13) scrapling-official agent skill (D4Vinci/Scrapling, BSD-3) ----------
if git clone --depth 1 --filter=blob:none --sparse https://github.com/D4Vinci/Scrapling.git "$TMP/scr" >/dev/null 2>&1; then
  git -C "$TMP/scr" sparse-checkout set agent-skill/Scrapling-Skill >/dev/null 2>&1 || true
  [ -d "$TMP/scr/agent-skill/Scrapling-Skill" ] && { rm -rf "$SK/scrapling-official"; cp -R "$TMP/scr/agent-skill/Scrapling-Skill" "$SK/scrapling-official"; }
fi

# --- 14) vercel-react-best-practices (vercel-labs/agent-skills, MIT) --------
if git clone --depth 1 --filter=blob:none --sparse https://github.com/vercel-labs/agent-skills.git "$TMP/va" >/dev/null 2>&1; then
  git -C "$TMP/va" sparse-checkout set skills/react-best-practices >/dev/null 2>&1 || true
  [ -d "$TMP/va/skills/react-best-practices" ] && { rm -rf "$SK/vercel-react-best-practices"; cp -R "$TMP/va/skills/react-best-practices" "$SK/vercel-react-best-practices"; }
fi

# --- 15) orca-cli skill (stablyai/orca, MIT; large repo -> sparse fetch) ----
if git clone --depth 1 --filter=blob:none --sparse https://github.com/stablyai/orca.git "$TMP/orca" >/dev/null 2>&1; then
  git -C "$TMP/orca" sparse-checkout set skills/orca-cli >/dev/null 2>&1 || true
  [ -d "$TMP/orca/skills/orca-cli" ] && { rm -rf "$SK/orca-cli"; cp -R "$TMP/orca/skills/orca-cli" "$SK/orca-cli"; }
fi

echo "[account-bootstrap] done: $(ls "$SK" | wc -l) skills, $(ls "$AG" 2>/dev/null | wc -l) agents"
