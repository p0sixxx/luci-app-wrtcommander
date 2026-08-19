#!/bin/sh
# Wrt Commander - install.sh
#
# Copies the files listed in deploy/MANIFEST onto a running OpenWrt
# router and reloads exactly the services needed to pick them up
# (rpcd for the ACL/ucode backend, LuCI's own dispatch index cache).
# No package manager involved - this is the manual-copy runtime.
#
# Usage (run ON the router, as root):
#   sh install.sh [--force-config]
#
# --force-config   also overwrite an existing /etc/config/wrtcommander
#                   (by default an existing config is left untouched)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$(cd "${SCRIPT_DIR}/../runtime" && pwd)"
MANIFEST="${SCRIPT_DIR}/MANIFEST"

FORCE_CONFIG=0
for arg in "$@"; do
	case "$arg" in
		--force-config) FORCE_CONFIG=1 ;;
		*) echo "Unknown option: $arg" >&2; exit 1 ;;
	esac
done

echo "== Wrt Commander installer =="

if [ "$(id -u)" != "0" ]; then
	echo "ERROR: this must be run as root on the router." >&2
	exit 1
fi

if [ ! -f /etc/openwrt_release ]; then
	echo "ERROR: /etc/openwrt_release not found - this does not look like an OpenWrt system." >&2
	exit 1
fi
# shellcheck disable=SC1091
. /etc/openwrt_release
echo "Target system: ${DISTRIB_ID:-OpenWrt} ${DISTRIB_RELEASE:-unknown}"

MISSING=0
command -v ubus >/dev/null 2>&1 || { echo "ERROR: ubus not found." >&2; MISSING=1; }
command -v rpcd >/dev/null 2>&1 || { echo "ERROR: rpcd not found." >&2; MISSING=1; }
command -v ucode >/dev/null 2>&1 || { echo "ERROR: ucode interpreter not found (opkg install ucode)." >&2; MISSING=1; }
[ -d /www/luci-static/resources ] || { echo "ERROR: LuCI does not appear to be installed (no /www/luci-static/resources)." >&2; MISSING=1; }
[ "$MISSING" = "1" ] && exit 1

if [ ! -d /usr/share/rpcd/ucode ]; then
	echo "WARNING: /usr/share/rpcd/ucode is missing - install 'rpcd-mod-ucode' or the backend will not load." >&2
fi
if ! command -v lua >/dev/null 2>&1 && [ ! -x /usr/bin/lua5.1 ]; then
	echo "WARNING: no Lua interpreter found - install 'luci-lua-runtime' or upload/download will not work." >&2
	echo "         (everything else - browsing, edit, delete, copy, move, permissions - still works)" >&2
fi

if [ ! -f "$MANIFEST" ]; then
	echo "ERROR: manifest not found at $MANIFEST" >&2
	exit 1
fi

echo "Validating ucode backend syntax..."
UCODE_SRC="${RUNTIME_DIR}/usr/share/rpcd/ucode/wrtcommander.uc"
if ! ucode "$UCODE_SRC" >/tmp/wrtcommander-ucode-check.log 2>&1; then
	echo "ERROR: wrtcommander.uc failed to parse - aborting before touching the live install:" >&2
	cat /tmp/wrtcommander-ucode-check.log >&2
	rm -f /tmp/wrtcommander-ucode-check.log
	exit 1
fi
rm -f /tmp/wrtcommander-ucode-check.log
echo "  OK"

echo "Installing files..."
while IFS= read -r line; do
	case "$line" in
		''|'#'*) continue ;;
	esac
	src=$(echo "$line" | awk '{print $1}')
	dst=$(echo "$line" | awk '{print $2}')
	[ -n "$src" ] && [ -n "$dst" ] || continue

	if [ "$dst" = "/etc/config/wrtcommander" ] && [ -f "$dst" ] && [ "$FORCE_CONFIG" != "1" ]; then
		echo "  skip    $dst (already exists - keeping your configuration, use --force-config to overwrite)"
		continue
	fi

	mkdir -p "$(dirname "$dst")"
	cp "${RUNTIME_DIR}/${src}" "$dst"
	chmod 0644 "$dst"
	echo "  install $dst"
done < "$MANIFEST"

# The app used to be called FileXplorer (luci-app-filexplorer). Those files
# sit at different absolute paths, so installing the renamed version does
# not replace them - it leaves a second copy of the app registered, with
# its own ubus object, its own ACL scopes and its own entry under
# Services. Remove them, once, by their exact paths: no wildcards, same
# rule as uninstall.sh.
OLD_FILES="/usr/share/rpcd/ucode/filexplorer.uc
/usr/share/rpcd/acl.d/luci-app-filexplorer.json
/usr/share/luci/menu.d/luci-app-filexplorer.json
/usr/lib/lua/luci/controller/filexplorer.lua
/usr/lib/lua/luci/i18n/filexplorer.ru.lmo
/www/luci-static/resources/view/filexplorer.js
/www/luci-static/resources/filexplorer/filexplorer.css"

old_found=0
for f in $OLD_FILES; do
	if [ -e "$f" ]; then
		if [ "$old_found" = 0 ]; then
			echo "Removing the previous FileXplorer installation..."
			old_found=1
		fi
		rm -f "$f"
		echo "  removed $f"
	fi
done
[ -d /www/luci-static/resources/filexplorer ] && \
	rmdir /www/luci-static/resources/filexplorer 2>/dev/null || true

# The old config is left in place deliberately - it holds the operator's
# allowed_root and limits, and the new package reads the same option
# names, so it can simply be copied across.
if [ "$old_found" = 1 ] && [ -f /etc/config/filexplorer ] && [ ! -f /etc/config/wrtcommander ]; then
	cp /etc/config/filexplorer /etc/config/wrtcommander
	echo "  carried /etc/config/filexplorer over to /etc/config/wrtcommander"
	echo "  (the old file is left alone; delete it once you are happy)"
fi

echo "Reloading rpcd and clearing the LuCI index cache..."
rm -f /tmp/luci-indexcache* 2>/dev/null || true
rm -f /tmp/luci-modulecache/* 2>/dev/null || true
if [ -x /etc/init.d/rpcd ]; then
	/etc/init.d/rpcd reload >/dev/null 2>&1 || /etc/init.d/rpcd restart >/dev/null 2>&1 || true
else
	echo "WARNING: /etc/init.d/rpcd not found, could not reload rpcd." >&2
fi

sleep 1
echo "Verifying the backend is registered on ubus..."
if ubus list 2>/dev/null | grep -qx 'luci.wrtcommander'; then
	echo "  luci.wrtcommander is registered."
else
	echo "WARNING: luci.wrtcommander was not found on ubus after reload." >&2
	echo "         Try: /etc/init.d/rpcd restart ; ubus list | grep wrtcommander" >&2
	echo "         Check: logread | grep rpcd" >&2
fi

if [ -f /usr/lib/lua/luci/i18n/wrtcommander.ru.lmo ]; then
	echo "Russian translation installed."
	echo "  LuCI shows it when its language is Russian or set to auto with a"
	echo "  Russian browser: System -> System -> Language, or"
	echo "  uci set luci.main.lang=ru; uci commit luci"
	if [ ! -f /usr/lib/lua/luci/i18n/base.ru.lmo ]; then
		echo "WARNING: LuCI's own Russian catalog (base.ru.lmo) is not installed," >&2
		echo "         so most of the surrounding interface stays English." >&2
		echo "         Install 'luci-i18n-base-ru' for a fully Russian LuCI." >&2
	fi
fi

echo
echo "Wrt Commander installed successfully."
echo "Open LuCI -> Services -> Wrt Commander in your browser."
echo "(If the menu entry is missing, log out and back in, or hard-refresh the page.)"
