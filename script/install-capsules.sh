#!/usr/bin/env bash
#
# Install the `capsules` command — this opencode fork with the capsule control
# plane — as its own CLI, separated from any upstream `opencode` install.
#
#   - runs from source via bun (no binary build)
#   - uses its own config/data dirs (OPENCODE_APP_NAME=capsules) so it never
#     shares state with opencode
#   - turns the capsule features on by default
#   - migrates an existing opencode provider login so you don't re-auth
#
# Usage:  bash script/install-capsules.sh   [bin-dir]
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${1:-${CAPSULES_BIN_DIR:-$HOME/.local/bin}}"
APP_NAME="capsules"

command -v bun >/dev/null 2>&1 || { echo "error: bun is required (https://bun.sh)"; exit 1; }
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/$APP_NAME" <<EOF
#!/usr/bin/env bash
# $APP_NAME — opencode fork + capsule control plane. Separate config dir from opencode.
set -euo pipefail
export OPENCODE_APP_NAME=$APP_NAME
export OPENCODE_EXPERIMENTAL_CAPSULE=1
export OPENCODE_EXPERIMENTAL_CAPSULE_RECONCILE=1
export OPENCODE_EXPERIMENTAL_CAPSULE_ADMISSION=1
# --cwd so bun uses packages/opencode's tsconfig (jsxImportSource=@opentui/solid);
# the working project is still taken from \$PWD, so '$APP_NAME' runs in your shell's dir.
exec bun run --cwd "$REPO/packages/opencode" --conditions=browser src/index.ts "\$@"
EOF
chmod +x "$BIN_DIR/$APP_NAME"

# Carry an existing opencode provider login over to the capsules data dir.
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}"
SRC_AUTH="$DATA_ROOT/opencode/auth.json"
DST_DIR="$DATA_ROOT/$APP_NAME"
if [ -f "$SRC_AUTH" ] && [ ! -f "$DST_DIR/auth.json" ]; then
  mkdir -p "$DST_DIR"
  cp "$SRC_AUTH" "$DST_DIR/auth.json"
  echo "→ migrated provider login to $DST_DIR/auth.json"
fi

echo "✓ installed: $BIN_DIR/$APP_NAME"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "✓ $BIN_DIR is on PATH — run:  $APP_NAME" ;;
  *) echo "! add $BIN_DIR to PATH, e.g.:  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
esac
