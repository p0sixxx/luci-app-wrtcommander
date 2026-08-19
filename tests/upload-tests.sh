#!/bin/sh
# Upload endpoint tests (plain HTTP via curl) against the Lua
# controller. Needs a logged-in LuCI session cookie.
#
# Run ON the router as root by default (talks to http://127.0.0.1), or
# set ROUTER_URL / ROUTER_USER / ROUTER_PASS to point at a remote one:
#   ROUTER_PASS=yourpass sh upload-tests.sh

. "$(dirname "$0")/lib.sh"

ROUTER_URL="${ROUTER_URL:-http://127.0.0.1}"
ROUTER_USER="${ROUTER_USER:-root}"
ROUTER_PASS="${ROUTER_PASS:-}"

command -v curl >/dev/null 2>&1 || { echo "curl is required for HTTP tests (opkg install curl)" >&2; exit 1; }
[ -d "$TESTFS" ] || { echo "Run make-testfs.sh first" >&2; exit 1; }

COOKIEJAR=$(mktemp)
trap 'rm -f "$COOKIEJAR"' EXIT

echo "Logging in to $ROUTER_URL as $ROUTER_USER..."
curl -s -c "$COOKIEJAR" \
	-d "luci_username=${ROUTER_USER}" -d "luci_password=${ROUTER_PASS}" \
	"${ROUTER_URL}/cgi-bin/luci/" -o /dev/null
grep -q sysauth "$COOKIEJAR" 2>/dev/null \
	|| echo "WARNING: could not confirm a session cookie was obtained - tests below may fail with 403." >&2

UPLOAD_URL="${ROUTER_URL}/cgi-bin/luci/admin/services/wrtcommander/upload"
DEST_ENC=$(printf '%s' "$TESTFS/uploads" | sed 's/ /%20/g')
mkdir -p "$TESTFS/uploads"

do_upload() {
	# do_upload <local-file> <dest-encoded> <overwrite 0|1>
	curl -s -b "$COOKIEJAR" -F "file=@${1}" "${UPLOAD_URL}?dest=${2}&overwrite=${3}"
}

echo "== Upload tests =="

: > /tmp/fx-upload-empty.txt
OUT=$(do_upload /tmp/fx-upload-empty.txt "$DEST_ENC" 1)
echo "$OUT" | grep -q '"ok":[[:space:]]*true' && { echo "PASS: upload an empty file"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: upload an empty file"; echo "$OUT"; FAIL=$((FAIL + 1)); }

printf 'small upload content\n' > /tmp/fx-upload-small.txt
OUT=$(do_upload /tmp/fx-upload-small.txt "$DEST_ENC" 1)
echo "$OUT" | grep -q '"ok":[[:space:]]*true' && { echo "PASS: upload a small file"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: upload a small file"; echo "$OUT"; FAIL=$((FAIL + 1)); }

cp /tmp/fx-upload-small.txt "/tmp/юникод-имя.txt"
OUT=$(do_upload "/tmp/юникод-имя.txt" "$DEST_ENC" 1)
echo "$OUT" | grep -q '"ok":[[:space:]]*true' && { echo "PASS: upload with a Unicode filename"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: upload with a Unicode filename"; echo "$OUT"; FAIL=$((FAIL + 1)); }

cp /tmp/fx-upload-small.txt "/tmp/name with spaces.txt"
OUT=$(do_upload "/tmp/name with spaces.txt" "$DEST_ENC" 1)
echo "$OUT" | grep -q '"ok":[[:space:]]*true' && { echo "PASS: upload with a space in the filename"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: upload with a space in the filename"; echo "$OUT"; FAIL=$((FAIL + 1)); }

OUT=$(do_upload /tmp/fx-upload-small.txt "$DEST_ENC" 0)
echo "$OUT" | grep -q '"code":[[:space:]]*"EEXIST"' && { echo "PASS: upload without overwrite refuses an existing file"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: expected EEXIST"; echo "$OUT"; FAIL=$((FAIL + 1)); }

OUT=$(do_upload /tmp/fx-upload-small.txt "$DEST_ENC" 1)
echo "$OUT" | grep -q '"ok":[[:space:]]*true' && { echo "PASS: upload with overwrite=1 replaces an existing file"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: overwrite upload"; echo "$OUT"; FAIL=$((FAIL + 1)); }

if [ -d /rom ]; then
	OUT=$(do_upload /tmp/fx-upload-small.txt "%2From" 1)
	echo "$OUT" | grep -qE '"code":[[:space:]]*"(EROFS|EACCES|EIO)"' && { echo "PASS: upload into /rom (read-only) is rejected"; PASS=$((PASS + 1)); } \
		|| { echo "FAIL: expected upload into /rom to be rejected"; echo "$OUT"; FAIL=$((FAIL + 1)); }
fi

dd if=/dev/urandom of=/tmp/fx-upload-large.bin bs=1024 count=2048 >/dev/null 2>&1
OUT=$(do_upload /tmp/fx-upload-large.bin "$DEST_ENC" 1)
echo "$OUT" | grep -q '"ok":[[:space:]]*true' && { echo "PASS: upload a 2 MiB file"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: upload a 2 MiB file"; echo "$OUT"; FAIL=$((FAIL + 1)); }
SIZE_REPORTED=$(echo "$OUT" | sed -n 's/.*"size":[[:space:]]*\([0-9]*\).*/\1/p')
[ "$SIZE_REPORTED" = "2097152" ] && { echo "PASS: reported size matches the 2 MiB payload exactly"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: size mismatch (got '$SIZE_REPORTED', expected 2097152)"; FAIL=$((FAIL + 1)); }

rm -f /tmp/fx-upload-empty.txt /tmp/fx-upload-small.txt /tmp/fx-upload-large.bin \
	"/tmp/юникод-имя.txt" "/tmp/name with spaces.txt"

# NOTE: a true "permission denied" (ACL) case needs a non-root LuCI
# user with the write scope withheld; this script only ever tests as
# an admin session, so that path is covered structurally (acl.d +
# session_has_access() in the Lua controller) rather than end-to-end
# here. See docs in README.md for how to test it manually.

summary
