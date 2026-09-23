#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
MIN_NODE_VERSION=24

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed. Version $MIN_NODE_VERSION+ is required."
  echo "  Install via: https://nodejs.org or your package manager"
  exit 1
fi

NODE_MAJOR=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if (( NODE_MAJOR < MIN_NODE_VERSION )); then
  echo "Error: Node.js v${MIN_NODE_VERSION}+ required (found v$(node -v | tr -d v))"
  exit 1
fi

# ---------------------------------------------------------------------------
# Install dependencies
# ---------------------------------------------------------------------------

echo "Installing dependencies..."
cd "$REPO_DIR"
npm install --omit=dev --silent

# ---------------------------------------------------------------------------
# Symlink CLI binaries
# ---------------------------------------------------------------------------

BIN_DIR="${PREFIX:-$HOME/.local}/bin"
mkdir -p "$BIN_DIR"

for cmd in bo; do
  src="$REPO_DIR/bin/${cmd}.mjs"
  chmod +x "$src"
  dest="$BIN_DIR/$cmd"

  if [ -L "$dest" ]; then
    rm "$dest"
  elif [ -e "$dest" ]; then
    echo "Error: $dest exists and is not a symlink; refusing to replace it."
    exit 1
  fi

  ln -s "$src" "$dest"
  echo "  Linked $dest -> $src"
done

# ---------------------------------------------------------------------------
# PATH check
# ---------------------------------------------------------------------------

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "Warning: $BIN_DIR is not in your PATH."
  echo "  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo ""
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
  echo ""
fi

# ---------------------------------------------------------------------------
# Install systemd user service
# ---------------------------------------------------------------------------

echo ""
if ! command -v systemctl &>/dev/null || ! systemctl --user show-environment &>/dev/null; then
  echo "systemd user session not available; start the server with: bo serve"
  echo ""
  echo "bo installed. Run 'bo --help' to get started."
  exit 0
fi

echo "Setting up bo server as a systemd user service..."

SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/bo.service"
mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=bo server
After=network.target

[Service]
Type=simple
ExecStart=$(command -v node) ${REPO_DIR}/bin/bo.mjs serve
WorkingDirectory=${REPO_DIR}
# PATH as seen at install time, so the service finds the claude and codex CLIs.
Environment="PATH=${PATH}"
Environment=HOST=127.0.0.1
Environment=PORT=3000
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now bo.service

echo "  Service installed and started."
echo "  Status: systemctl --user status bo"
echo "  Logs:   journalctl --user -u bo -f"

echo ""
echo "bo installed. Run 'bo --help' to get started."
