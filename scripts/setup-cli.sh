#!/usr/bin/env bash
# Set up shared memory for Claude Code without MCP:
#   1. link bin/agent-memory onto PATH
#   2. agent-memory init: save API URL + key (prompted, never a flag) and allowlist the CLI
#   3. install the agent-memory-cli plugin (skill + SessionStart hook)
# Safe to re-run: each step skips what is already done.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="smargovsky/shared-agent-memory"
MARKETPLACE="shared-agent-memory"
BIN_DIR="$HOME/.local/bin"
SCOPE="user"
API_URL=""
INSTALL_PLUGIN=1
INIT_ARGS=()

usage() {
  cat <<'USAGE'
Usage: scripts/setup-cli.sh [--api-url URL] [--scope user|project] [--bin-dir DIR]
                            [--source owner/repo|path] [--local] [--no-plugin] [--insecure]

  --api-url URL   Memory API base URL (https). Needed the first time; later runs keep the saved one.
  --scope         Where the allowlist and plugin go: user (~/.claude) or project (./.claude). Default user.
  --bin-dir DIR   Where to link agent-memory. Default ~/.local/bin.
  --source        Marketplace to install the plugin from. Default smargovsky/shared-agent-memory.
  --local         Install the plugin from this checkout instead (for testing).
  --no-plugin     Skip the Claude Code plugin install.
  --insecure      Allow plain http to a non-local API (not recommended).

The API key is prompted for by 'agent-memory init'. To pipe it instead:
  printf '%s\n' "$KEY" | scripts/setup-cli.sh --api-url https://memory.example.com
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --local) SOURCE="$ROOT"; shift ;;
    --no-plugin) INSTALL_PLUGIN=0; shift ;;
    --insecure) INIT_ARGS+=(--insecure); shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$SCOPE" in user|project) ;; *) echo "--scope must be user or project" >&2; exit 2 ;; esac

if [ ! -f "$ROOT/dist/cli.js" ]; then
  echo "Missing $ROOT/dist/cli.js. Run 'npm install && npm run bundle' first." >&2
  exit 1
fi

# 1. Link the CLI. Never replace a real file someone put there.
mkdir -p "$BIN_DIR"
LINK="$BIN_DIR/agent-memory"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "$LINK exists and is not a symlink; leaving it alone. Remove it and re-run." >&2
  exit 1
fi
ln -sfn "$ROOT/bin/agent-memory" "$LINK"
echo "Linked $LINK -> $ROOT/bin/agent-memory"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not on PATH. Add it, or the hook and allowlist won't find agent-memory." >&2 ;;
esac

# 2. Credentials + allowlist.
if [ -n "$API_URL" ]; then INIT_ARGS+=(--api-url "$API_URL"); fi
"$LINK" init --allowlist --scope "$SCOPE" ${INIT_ARGS[@]+"${INIT_ARGS[@]}"}

# 3. Plugin.
if [ "$INSTALL_PLUGIN" = "1" ]; then
  if ! command -v claude >/dev/null 2>&1; then
    echo "claude CLI not found; skipping plugin install. Install it later with:" >&2
    echo "  claude plugin marketplace add $SOURCE && claude plugin install agent-memory-cli@$MARKETPLACE" >&2
  else
    # Prints the existing marketplace's source (repo or path), or nothing if it isn't added.
    EXISTING="$(claude plugin marketplace list --json | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const m = JSON.parse(s).find((x) => x.name === process.argv[1]);
        if (m) console.log(m.repo || m.path || m.url || m.source);
      });' "$MARKETPLACE")"
    if [ -z "$EXISTING" ]; then
      claude plugin marketplace add "$SOURCE"
    elif [ "$EXISTING" = "$SOURCE" ]; then
      echo "Marketplace $MARKETPLACE already added; refreshing it."
      claude plugin marketplace update "$MARKETPLACE"
    else
      echo "A marketplace named $MARKETPLACE already points at $EXISTING, not $SOURCE." >&2
      echo "Remove it first: claude plugin marketplace remove $MARKETPLACE" >&2
      exit 1
    fi
    claude plugin install "agent-memory-cli@$MARKETPLACE" --scope "$SCOPE"
  fi
fi

echo
echo "Done. Check it with: agent-memory config"
echo "Start a new Claude Code session to load the skill and hook."
