#!/bin/sh
# Path-security tests: traversal, encoded traversal, backslash
# traversal, absolute-path escape and symlink escape must all be
# rejected once allowed_root is restricted to a subtree.
#
# This temporarily points allowed_root at the test filesystem so the
# "escape the root" checks are meaningful, then restores the original
# setting on exit - it never runs destructive traversal tests directly
# against a wide-open "/" root.

. "$(dirname "$0")/lib.sh"

[ -d "$TESTFS" ] || { echo "Run make-testfs.sh first" >&2; exit 1; }

echo "== Security tests (path traversal / symlink escape) =="
echo "Temporarily restricting allowed_root to $TESTFS for this run..."

ORIG_ROOT=$(uci -q get filexplorer.main.allowed_root)
[ -z "$ORIG_ROOT" ] && ORIG_ROOT="/"

restore() {
	uci set filexplorer.main.allowed_root="$ORIG_ROOT"
	uci commit filexplorer
	/etc/init.d/rpcd reload >/dev/null 2>&1 || /etc/init.d/rpcd restart >/dev/null 2>&1
}
trap restore EXIT INT TERM

uci set filexplorer.main.allowed_root="$TESTFS"
uci commit filexplorer
/etc/init.d/rpcd reload >/dev/null 2>&1 || /etc/init.d/rpcd restart >/dev/null 2>&1
sleep 1

expect_ok   "list the (now restricted) root itself"      "$(ubus_call list "{\"path\":\"$TESTFS\"}")"
expect_fail "reject ../ escaping the root"                "$(ubus_call list "{\"path\":\"$TESTFS/../\"}")" EACCES
expect_fail "reject ../../ escaping the root"              "$(ubus_call list "{\"path\":\"$TESTFS/../../\"}")" EACCES
expect_fail "reject deep ../../../ traversal"               "$(ubus_call list "{\"path\":\"$TESTFS/../../../etc\"}")" EACCES
expect_fail "reject absolute /etc/passwd outside the root"   "$(ubus_call stat "{\"path\":\"/etc/passwd\"}")" EACCES
expect_fail "reject /etc/../etc/shadow-style path"            "$(ubus_call stat "{\"path\":\"$TESTFS/../etc/shadow\"}")" EACCES

# Encoded traversal: ubus JSON string arguments are not URL-decoded by
# anything in this stack, so a literal "%2e%2e" is just an (nonexistent)
# filename - proving the backend never performs its own decoding pass
# (which is what would make double-encoding attacks possible).
expect_fail "literal %2e%2e is treated as a filename, not decoded" \
	"$(ubus_call stat "{\"path\":\"$TESTFS/%2e%2e/etc/passwd\"}")" ENOENT
expect_fail "literal double-encoded %252e%252e is treated as a filename" \
	"$(ubus_call stat "{\"path\":\"$TESTFS/%252e%252e\"}")" ENOENT

# Backslash is not a path separator on Linux, so "..\..\etc" is a
# single, nonexistent file name rather than a traversal sequence.
expect_fail "backslash sequence is not treated as a separator" \
	"$(ubus_call stat "{\"path\":\"$TESTFS/..\\\\..\\\\etc\"}")" ENOENT

# Symlink escape: a symlink that lives inside the root but points
# outside it must be rejected, both directly and nested one level deep.
ln -sf /etc "$TESTFS/escape-symlink"
expect_fail "reject a symlink that resolves outside the root" \
	"$(ubus_call list "{\"path\":\"$TESTFS/escape-symlink\"}")" EACCES
rm -f "$TESTFS/escape-symlink"

mkdir -p "$TESTFS/nested-escape"
ln -sf /etc/shadow "$TESTFS/nested-escape/link"
expect_fail "reject a nested symlink escaping the root" \
	"$(ubus_call stat "{\"path\":\"$TESTFS/nested-escape/link\"}")" EACCES
rm -rf "$TESTFS/nested-escape"

# Every mutating method must be equally protected, not just list/stat.
expect_fail "reject write to a path outside the root" \
	"$(ubus_call write "{\"path\":\"/etc/passwd\",\"data\":\"eA==\"}")" EACCES
expect_bulk_item_fail "reject remove of a path outside the root" \
	"$(ubus_call remove "{\"paths\":[\"/etc/passwd\"]}")" EACCES
expect_bulk_item_fail "reject remove of the allowed root itself" \
	"$(ubus_call remove "{\"paths\":[\"$TESTFS\"]}")" EACCES
expect_fail "reject mkdir outside the root" \
	"$(ubus_call mkdir "{\"path\":\"/tmp-outside-root/x\"}")" EACCES
expect_fail "reject chmod outside the root" \
	"$(ubus_call chmod "{\"path\":\"/etc/passwd\",\"mode\":420}")" EACCES

# NUL-byte injection is intentionally not exercised here: argv strings
# (which "ubus call" builds its JSON from) are themselves NUL-terminated
# C strings, so there is no way to smuggle a literal NUL byte through
# the ubus CLI to begin with. The backend still guards against one
# arriving via a raw ubus/JSON-RPC client (see canon() in filexplorer.uc).

summary
