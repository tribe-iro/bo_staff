#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
MIN_NODE_VERSION=22

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

for cmd in bo bo.claude bo.codex; do
  src="$REPO_DIR/bin/${cmd}.mjs"
  chmod +x "$src"
  dest="$BIN_DIR/$cmd"

  if [ -L "$dest" ] || [ -e "$dest" ]; then
    rm "$dest"
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
echo "Setting up bo_staff server as a systemd user service..."

SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/bo-staff.service"
mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=bo_staff gateway server
After=network.target

[Service]
Type=simple
ExecStart=$(command -v node) ${REPO_DIR}/src/server.ts
WorkingDirectory=${REPO_DIR}
Environment=HOST=127.0.0.1
Environment=PORT=3000
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now bo-staff.service

echo "  Service installed and started."
echo "  Status: systemctl --user status bo-staff"
echo "  Logs:   journalctl --user -u bo-staff -f"

echo ""
echo "bo_staff installed. Run 'bo --help' to get started."
