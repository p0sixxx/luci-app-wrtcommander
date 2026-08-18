#!/bin/sh
# FileXplorer - uninstall.sh
#
# Removes exactly the files listed in deploy/MANIFEST - nothing else.
# Never touches anything outside that fixed list, so it can never
# reach into user data or unrelated OpenWrt system files.
#
# Usage (run ON the router, as root):
#   sh uninstall.sh [--purge]
#
# --purge   also remove /etc/config/filexplorer (kept by default in
#            case you want to reinstall later with the same settings)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="${SCRIPT_DIR}/MANIFEST"

PURGE=0
for arg in "$@"; do
	case "$arg" in
		--purge) PURGE=1 ;;
		*) echo "Unknown option: $arg" >&2; exit 1 ;;
	esac
done

echo "== FileXplorer uninstaller =="

if [ "$(id -u)" != "0" ]; then
	echo "ERROR: this must be run as root on the router." >&2
	exit 1
fi
if [ ! -f "$MANIFEST" ]; then
	echo "ERROR: manifest not found at $MANIFEST" >&2
	exit 1
fi

echo "Removing files..."
while IFS= read -r line; do
	case "$line" in
		''|'#'*) continue ;;
	esac
	dst=$(echo "$line" | awk '{print $2}')
	[ -n "$dst" ] || continue

	if [ "$dst" = "/etc/config/filexplorer" ] && [ "$PURGE" != "1" ]; then
		echo "  keep    $dst (use --purge to remove configuration too)"
		continue
	fi

	if [ -e "$dst" ]; then
		rm -f "$dst"
		echo "  removed $dst"
	else
		echo "  absent  $dst"
	fi
done < "$MANIFEST"

rm -f /tmp/filexplorer-debug.log 2>/dev/null || true

echo "Reloading rpcd and clearing the LuCI index cache..."
rm -f /tmp/luci-indexcache* 2>/dev/null || true
rm -f /tmp/luci-modulecache/* 2>/dev/null || true
if [ -x /etc/init.d/rpcd ]; then
	/etc/init.d/rpcd reload >/dev/null 2>&1 || /etc/init.d/rpcd restart >/dev/null 2>&1 || true
fi

echo
echo "FileXplorer has been uninstalled."
if [ "$PURGE" != "1" ]; then
	echo "Configuration kept at /etc/config/filexplorer - remove manually or re-run with --purge."
fi
