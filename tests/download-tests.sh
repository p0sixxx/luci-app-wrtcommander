#!/bin/sh
# Download endpoint tests (plain HTTP via curl) against the Lua
# controller. Needs a logged-in LuCI session cookie.
#
# Run ON the router as root by default (talks to http://127.0.0.1), or
# set ROUTER_URL / ROUTER_USER / ROUTER_PASS to point at a remote one.

. "$(dirname "$0")/lib.sh"

ROUTER_URL="${ROUTER_URL:-http://127.0.0.1}"
ROUTER_USER="${ROUTER_USER:-root}"
ROUTER_PASS="${ROUTER_PASS:-}"

command -v curl >/dev/null 2>&1 || { echo "curl is required for HTTP tests (opkg install curl)" >&2; exit 1; }
[ -d "$TESTFS" ] || { echo "Run make-testfs.sh first" >&2; exit 1; }

COOKIEJAR=$(mktemp)
OUTDIR=$(mktemp -d)
trap 'rm -f "$COOKIEJAR"; rm -rf "$OUTDIR"' EXIT

echo "Logging in to $ROUTER_URL as $ROUTER_USER..."
curl -s -c "$COOKIEJAR" \
	-d "luci_username=${ROUTER_USER}" -d "luci_password=${ROUTER_PASS}" \
	"${ROUTER_URL}/cgi-bin/luci/" -o /dev/null
grep -q sysauth "$COOKIEJAR" 2>/dev/null \
	|| echo "WARNING: could not confirm a session cookie was obtained - tests below may fail with 403." >&2

DOWNLOAD_URL="${ROUTER_URL}/cgi-bin/luci/admin/system/filexplorer/download"

url_encode_path() {
	# minimal encoder: percent-encode space and non-ASCII bytes are left
	# to curl's own URL handling via --data-urlencode-style is overkill
	# here, so we rely on curl's -G/--data-urlencode instead (see below).
	printf '%s' "$1"
}

do_download() {
	# do_download <remote-path> <out-file>
	curl -s -G -b "$COOKIEJAR" --data-urlencode "path=$1" -o "$2" -w '%{http_code}' "$DOWNLOAD_URL"
}

echo "== Download tests =="

: > "$TESTFS/dl-empty.txt"
CODE=$(do_download "$TESTFS/dl-empty.txt" "$OUTDIR/empty.out")
[ "$CODE" = "200" ] && [ ! -s "$OUTDIR/empty.out" ] && { echo "PASS: download an empty file"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: download an empty file (http=$CODE)"; FAIL=$((FAIL + 1)); }

dd if=/dev/urandom of="$TESTFS/dl-binary.bin" bs=1024 count=64 >/dev/null 2>&1
CODE=$(do_download "$TESTFS/dl-binary.bin" "$OUTDIR/binary.out")
if [ "$CODE" = "200" ] && cmp -s "$TESTFS/dl-binary.bin" "$OUTDIR/binary.out"; then
	echo "PASS: download a binary file (byte-for-byte match)"; PASS=$((PASS + 1))
else
	echo "FAIL: binary download mismatch (http=$CODE)"; FAIL=$((FAIL + 1))
fi

dd if=/dev/urandom of="$TESTFS/dl-large.bin" bs=1024 count=4096 >/dev/null 2>&1
CODE=$(do_download "$TESTFS/dl-large.bin" "$OUTDIR/large.out")
if [ "$CODE" = "200" ] && cmp -s "$TESTFS/dl-large.bin" "$OUTDIR/large.out"; then
	echo "PASS: download a 4 MiB file (byte-for-byte match, streamed)"; PASS=$((PASS + 1))
else
	echo "FAIL: large download mismatch (http=$CODE)"; FAIL=$((FAIL + 1))
fi

CODE=$(do_download "$TESTFS/русский.txt" "$OUTDIR/unicode.out")
[ "$CODE" = "200" ] && cmp -s "$TESTFS/русский.txt" "$OUTDIR/unicode.out" \
	&& { echo "PASS: download a file with a Unicode name"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: unicode-name download (http=$CODE)"; FAIL=$((FAIL + 1)); }

CODE=$(do_download "$TESTFS/file with spaces.txt" "$OUTDIR/spaces.out")
[ "$CODE" = "200" ] && cmp -s "$TESTFS/file with spaces.txt" "$OUTDIR/spaces.out" \
	&& { echo "PASS: download a file with a space in the name"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: space-name download (http=$CODE)"; FAIL=$((FAIL + 1)); }

CODE=$(do_download "$TESTFS/does-not-exist.txt" "$OUTDIR/missing.out")
[ "$CODE" = "404" ] && { echo "PASS: nonexistent file returns 404"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: expected 404 for a nonexistent file (got $CODE)"; FAIL=$((FAIL + 1)); }

CODE=$(do_download "$TESTFS/symlink" "$OUTDIR/symlink.out")
[ "$CODE" = "200" ] && cmp -s "$TESTFS/file.txt" "$OUTDIR/symlink.out" \
	&& { echo "PASS: download through a symlink returns the target's content"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: symlink download (http=$CODE)"; FAIL=$((FAIL + 1)); }

CODE=$(do_download "$TESTFS" "$OUTDIR/dir.out")
[ "$CODE" = "400" ] && { echo "PASS: downloading a directory is rejected"; PASS=$((PASS + 1)); } \
	|| { echo "FAIL: expected 400 when downloading a directory (got $CODE)"; FAIL=$((FAIL + 1)); }

# The default allowed_root is "/", so /etc/passwd is legitimately
# downloadable by an admin by design (this is an admin-grade whole-
# filesystem tool, see README - "no artificial restriction on system
# directories"). To exercise the containment check on this HTTP
# endpoint too, temporarily restrict allowed_root the same way
# security-tests.sh does, then restore it.
ORIG_ROOT=$(uci -q get filexplorer.main.allowed_root)
[ -z "$ORIG_ROOT" ] && ORIG_ROOT="/"
uci set filexplorer.main.allowed_root="$TESTFS"
uci commit filexplorer
/etc/init.d/rpcd reload >/dev/null 2>&1 || /etc/init.d/rpcd restart >/dev/null 2>&1
sleep 1

CODE=$(do_download "/etc/passwd" "$OUTDIR/escape.out")
if [ "$CODE" = "403" ] || [ "$CODE" = "400" ]; then
	echo "PASS: download outside a restricted allowed_root is rejected (http=$CODE)"; PASS=$((PASS + 1))
else
	echo "FAIL: expected the out-of-root download to be rejected (got $CODE)"; FAIL=$((FAIL + 1))
fi

uci set filexplorer.main.allowed_root="$ORIG_ROOT"
uci commit filexplorer
/etc/init.d/rpcd reload >/dev/null 2>&1 || /etc/init.d/rpcd restart >/dev/null 2>&1

rm -f "$TESTFS/dl-empty.txt" "$TESTFS/dl-binary.bin" "$TESTFS/dl-large.bin"

summary
