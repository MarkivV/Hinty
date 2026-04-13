#!/bin/bash
set -e

# ── Usage ──
# npm run release              → auto-detect version bump from commit messages
# npm run release -- patch     → force patch bump (1.1.0 → 1.1.1)
# npm run release -- minor     → force minor bump (1.1.0 → 1.2.0)
# npm run release -- major     → force major bump (1.1.0 → 2.0.0)

BUMP_TYPE="${1:-auto}"

echo "📋 Generating changelog and bumping version..."

if [ "$BUMP_TYPE" = "auto" ]; then
  npx standard-version
elif [ "$BUMP_TYPE" = "patch" ] || [ "$BUMP_TYPE" = "minor" ] || [ "$BUMP_TYPE" = "major" ]; then
  npx standard-version --release-as "$BUMP_TYPE"
else
  echo "❌ Invalid bump type: $BUMP_TYPE (use: auto, patch, minor, major)"
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

echo ""
echo "📦 Building and releasing Hinty ${TAG}..."

# Build the app
npm run build:mac

# Delete existing release if any
gh release delete "$TAG" --repo MarkivV/Hinty --yes 2>/dev/null || true

# Copy DMG with a stable name so the website download link always works:
# https://github.com/MarkivV/Hinty/releases/latest/download/Hinty-universal.dmg
cp "release/Hinty-${VERSION}-universal.dmg" release/Hinty-universal.dmg

# Extract changelog for this version to use as release notes
NOTES=$(sed -n "/^## \[${VERSION}\]/,/^## \[/p" CHANGELOG.md | sed '1d;$d')
if [ -z "$NOTES" ]; then
  NOTES="Release ${TAG}"
fi

# Upload all artifacts with changelog as release notes
gh release create "$TAG" --repo MarkivV/Hinty --title "Hinty ${TAG}" --latest \
  --notes "$NOTES" \
  release/Hinty-universal.dmg \
  release/Hinty-${VERSION}-universal.dmg \
  release/Hinty-${VERSION}-universal.dmg.blockmap \
  release/Hinty-${VERSION}-universal-mac.zip \
  release/Hinty-${VERSION}-universal-mac.zip.blockmap \
  release/latest-mac.yml

echo ""
echo "✅ Released: https://github.com/MarkivV/Hinty/releases/tag/${TAG}"
echo "📥 Download: https://github.com/MarkivV/Hinty/releases/latest/download/Hinty-universal.dmg"
