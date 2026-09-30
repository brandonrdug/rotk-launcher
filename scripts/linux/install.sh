#!/usr/bin/env bash
# Build the Linux launcher from this checkout and install it for the current
# user: ~/.local/opt/rotk-launcher, ~/.local/bin/rotk-launcher and a desktop
# entry.
#
#   scripts/linux/install.sh            build + install the current checkout
#   scripts/linux/install.sh --update   rebase the linux branch onto the newest
#                                       upstream release tag first
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
prefix="${XDG_DATA_HOME:-$HOME/.local/share}"
opt="$HOME/.local/opt/rotk-launcher"
bin="$HOME/.local/bin"
cd "$repo"

if [[ "${1:-}" == "--update" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree is dirty; commit or stash first." >&2
    exit 1
  fi
  upstream_url="https://github.com/h1z1rotk/rotk-launcher.git"
  git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$upstream_url"
  git fetch --tags upstream
  tag="$(git tag --list 'v*' --sort=-v:refname | head -n1)"
  echo "Rebasing $(git branch --show-current) onto $tag"
  git rebase "$tag"
fi

npm ci
npm run dist:linux

if pgrep -f "$opt/rotk-launcher" >/dev/null; then
  echo "ROTK Launcher is running; close it before installing." >&2
  exit 1
fi
mkdir -p "$(dirname "$opt")"
rm -rf "$opt.new"
cp -a release/linux-unpacked "$opt.new"
rm -rf "$opt"
mv "$opt.new" "$opt"

mkdir -p "$bin" "$prefix/applications" "$prefix/icons/hicolor/256x256/apps"
ln -sf "$opt/rotk-launcher" "$bin/rotk-launcher"
cp public/branding/rotk-mark.png "$prefix/icons/hicolor/256x256/apps/rotk-launcher.png"
cat > "$prefix/applications/rotk-launcher.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=ROTK Launcher
Comment=Return of the King launcher for H1Z1
Exec=$opt/rotk-launcher %U
Icon=rotk-launcher
Terminal=false
Categories=Game;
StartupWMClass=rotk-launcher
EOF
update-desktop-database "$prefix/applications" 2>/dev/null || true

echo "Installed $(node -p "require('./package.json').version") to $opt"

# The server requires the SMBIOS system UUID and baseboard serial, which the
# kernel only lets root read.
if [[ ! -r /sys/class/dmi/id/product_uuid || ! -r /sys/class/dmi/id/board_serial ]]; then
  cat <<MSG

The launcher cannot read your SMBIOS system UUID / baseboard serial, which the
ROTK server requires (launch fails with "hwid_required"). Allow it with:

  sudo install -m 0644 scripts/linux/rotk-launcher-dmi.conf /etc/tmpfiles.d/
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/rotk-launcher-dmi.conf

MSG
fi
