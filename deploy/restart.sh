#!/bin/sh
# Proton File Manager - restart.sh
#
# Reloads exactly what is needed to pick up updated files after a
# re-copy during development: rpcd (ACL + ucode backend) and LuCI's
# dispatch index cache. Deliberately does NOT restart uhttpd or any
# other unrelated service.
#
# Usage (run ON the router, as root):
#   sh restart.sh

set -e

if [ "$(id -u)" != "0" ]; then
	echo "ERROR: this must be run as root on the router." >&2
	exit 1
fi

UCODE_SRC="/usr/share/rpcd/ucode/filemanager.uc"
if command -v ucode >/dev/null 2>&1 && [ -f "$UCODE_SRC" ]; then
	echo "Checking backend syntax..."
	if ! ucode "$UCODE_SRC" >/tmp/proton-fm-ucode-check.log 2>&1; then
		echo "ERROR: $UCODE_SRC fails to parse, not reloading rpcd:" >&2
		cat /tmp/proton-fm-ucode-check.log >&2
		rm -f /tmp/proton-fm-ucode-check.log
		exit 1
	fi
	rm -f /tmp/proton-fm-ucode-check.log
	echo "  OK"
fi

echo "Clearing LuCI index cache..."
rm -f /tmp/luci-indexcache* 2>/dev/null || true
rm -f /tmp/luci-modulecache/* 2>/dev/null || true

echo "Reloading rpcd..."
if [ -x /etc/init.d/rpcd ]; then
	/etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart
else
	echo "WARNING: /etc/init.d/rpcd not found" >&2
fi

sleep 1
if ubus list 2>/dev/null | grep -qx 'luci.filemanager'; then
	echo "luci.filemanager is registered on ubus."
else
	echo "WARNING: luci.filemanager is not registered. Check: logread | grep rpcd" >&2
fi

echo "Done. Reload the File Manager page in your browser (hard-refresh if JS/CSS look stale)."
