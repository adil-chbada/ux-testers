#!/usr/bin/env bash
# One-step install of ux-testers. People run it; AI agents run it when asked to "install ux-testers".
#   bash install.sh             install, link the Claude skill, check everything
#   bash install.sh --yes       also install Bun without asking, if it is missing
#   bash install.sh --mcp       also register the MCP server for Claude Code (user scope)
#   bash install.sh --skip-skill   do not link the skill into ~/.claude/skills
set -euo pipefail
cd "$(dirname "$0")"
YES=0 MCP=0 SKILL=1
for a in "$@"; do case "$a" in --yes|-y) YES=1;; --mcp) MCP=1;; --skip-skill) SKILL=0;; *) echo "unknown option $a"; exit 1;; esac; done
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

step "1/5 Bun"
if ! command -v bun >/dev/null 2>&1; then
  if [ "$YES" = 1 ] || { [ -t 0 ] && read -rp "Bun is needed. Install it now with the official installer (bun.sh)? [y/N] " r && [[ $r =~ ^[Yy] ]]; }; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  else
    echo "Install Bun from https://bun.sh, then run: bash install.sh"; exit 1
  fi
fi
echo "Bun $(bun --version)"

step "2/5 Packages"
bun install --frozen-lockfile 2>/dev/null || bun install

step "3/5 Browser (Chromium for Playwright)"
bunx playwright install chromium

step "4/5 Claude skill"
if [ "$SKILL" = 1 ]; then
  mkdir -p "$HOME/.claude/skills"
  if [ -e "$HOME/.claude/skills/ux-testers" ]; then echo "already there: ~/.claude/skills/ux-testers"
  else ln -s "$PWD/skill" "$HOME/.claude/skills/ux-testers" && echo "linked ~/.claude/skills/ux-testers → $PWD/skill"; fi
else echo "skipped (--skip-skill)"; fi
if [ "$MCP" = 1 ]; then
  if command -v claude >/dev/null 2>&1; then claude mcp add --scope user ux-testers -- bun "$PWD/src/mcp.ts" && echo "MCP server registered: ux-testers"
  else echo "Claude CLI not found: MCP not registered"; fi
fi

step "5/5 Check"
bun src/doctor.ts || true
cat <<EOF

Next:
  1. If the check above shows ✗ for the Claude CLI, run: claude auth login   (yourself, in a terminal)
  2. Describe your app once:  bun run init my-app
  3. Start your app's dev server, then run testers:  bun run ux my-app
Or just ask Claude: "run 2 test users on my app at http://localhost:3000"
EOF
