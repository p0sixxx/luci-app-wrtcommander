#!/bin/sh
# Editor round-trip tests against the "luci.filexplorer" ubus object:
# empty file, UTF-8/Russian text, JSON, a UCI-style config, large-file
# rejection, external-modification conflict detection, and read-only
# filesystem behaviour (/rom).

. "$(dirname "$0")/lib.sh"

[ -d "$TESTFS" ] || { echo "Run make-testfs.sh first" >&2; exit 1; }

echo "== Editor tests =="

: > "$TESTFS/edit-empty.txt"
expect_ok "open an empty file for editing" \
	"$(ubus_call read "{\"path\":\"$TESTFS/edit-empty.txt\",\"mode\":\"edit\"}")"

printf 'привет мир\n' > "$TESTFS/edit-utf8.txt"
READ_UTF8=$(ubus_call read "{\"path\":\"$TESTFS/edit-utf8.txt\",\"mode\":\"edit\"}")
expect_ok "open a UTF-8/Russian text file for editing" "$READ_UTF8"

DATA_B64=$(echo "$READ_UTF8" | sed -n 's/.*"data":[[:space:]]*"\([^"]*\)".*/\1/p')
MTIME=$(echo "$READ_UTF8" | sed -n 's/.*"mtime":[[:space:]]*\([0-9]*\).*/\1/p')
SIZE=$(echo "$READ_UTF8" | sed -n 's/.*"size":[[:space:]]*\([0-9]*\).*/\1/p')
expect_ok "write back the same UTF-8 content unchanged (newline preserved)" \
	"$(ubus_call write "{\"path\":\"$TESTFS/edit-utf8.txt\",\"data\":\"$DATA_B64\",\"encoding\":\"base64\",\"expected_mtime\":$MTIME,\"expected_size\":$SIZE}")"

printf '{"a":1,"b":[1,2,3]}\n' > "$TESTFS/edit-config.json"
expect_ok "open a JSON file for editing" \
	"$(ubus_call read "{\"path\":\"$TESTFS/edit-config.json\",\"mode\":\"edit\"}")"

printf "config interface 'lan'\n\toption device 'br-lan'\n\toption proto 'static'\n" > "$TESTFS/edit-network.uci"
expect_ok "open a UCI-style config file for editing" \
	"$(ubus_call read "{\"path\":\"$TESTFS/edit-network.uci\",\"mode\":\"edit\"}")"

expect_fail "editing a file above editor_max_size is rejected" \
	"$(ubus_call read "{\"path\":\"$TESTFS/large.txt\",\"mode\":\"edit\"}")" EFBIG

# external modification -> conflict on save
READ1=$(ubus_call read "{\"path\":\"$TESTFS/edit-utf8.txt\",\"mode\":\"edit\"}")
MTIME1=$(echo "$READ1" | sed -n 's/.*"mtime":[[:space:]]*\([0-9]*\).*/\1/p')
SIZE1=$(echo "$READ1" | sed -n 's/.*"size":[[:space:]]*\([0-9]*\).*/\1/p')
sleep 1
printf 'changed by someone else\n' > "$TESTFS/edit-utf8.txt"
expect_fail "save is refused after the file changed externally" \
	"$(ubus_call write "{\"path\":\"$TESTFS/edit-utf8.txt\",\"data\":\"eA==\",\"encoding\":\"base64\",\"expected_mtime\":$MTIME1,\"expected_size\":$SIZE1}")" ECONFLICT
expect_ok "save succeeds with force=true, overwriting the external change" \
	"$(ubus_call write "{\"path\":\"$TESTFS/edit-utf8.txt\",\"data\":\"eA==\",\"encoding\":\"base64\",\"expected_mtime\":$MTIME1,\"expected_size\":$SIZE1,\"force\":true}")"

# read-only filesystem: /rom is the read-only squashfs lower layer
# that every OpenWrt overlay setup exposes
if [ -d /rom/etc ]; then
	ROM_FILE=$(find /rom/etc -maxdepth 1 -type f 2>/dev/null | head -n 1)
	if [ -n "$ROM_FILE" ]; then
		expect_ok "read a file straight from /rom" \
			"$(ubus_call read "{\"path\":\"$ROM_FILE\",\"mode\":\"preview\"}")"
		expect_fail "writing into /rom fails with a clear read-only error" \
			"$(ubus_call write "{\"path\":\"$ROM_FILE\",\"data\":\"eA==\",\"encoding\":\"base64\"}")" EROFS
	else
		echo "SKIP: no plain file found directly under /rom/etc"
	fi
else
	echo "SKIP: /rom/etc not present on this system"
fi

# NOTE: a classic owner/group/other "permission denied" is not
# meaningfully reproducible here because rpcd (and this backend) run
# as root, which bypasses normal Unix file permission checks. The
# read-only-filesystem case above is the realistic "write denied"
# scenario for a privileged whole-filesystem admin tool like this one.

summary
