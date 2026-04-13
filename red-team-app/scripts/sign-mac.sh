#!/bin/bash
# Ad-hoc sign the macOS app so TCC permissions persist between launches
set -e

APP_PATH="release/mac-universal/Hinty.app"

if [ ! -d "$APP_PATH" ]; then
  echo "[sign] App not found at $APP_PATH, skipping"
  exit 0
fi

echo "[sign] Ad-hoc signing $APP_PATH..."

# Sign all nested frameworks and helpers first, then the app itself
codesign --force --deep --sign - "$APP_PATH"

echo "[sign] Verifying signature..."
codesign --verify --verbose "$APP_PATH" 2>&1 || true

echo "[sign] Done"
