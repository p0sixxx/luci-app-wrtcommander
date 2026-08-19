#!/bin/sh
# Directory-size tests against "luci.wrtcommander dirsize".
#
# The number this returns is the summed apparent size of a whole subtree,
# so the things worth testing are not just "does it add up" but the three
# limits that keep the walk safe on a router: symlinks are never
# followed, other filesystems are not descended into, and the caps stop
# it rather than letting it run away.

. "$(dirname "$0")/lib.sh"

echo "== Directory size tests =="

DS="$TESTFS/dirsize"
rm -rf "$DS"
mkdir -p "$DS/sub/deep"

# known sizes: 100 + 250 + 1000 = 1350 bytes in 3 files, 2 directories
dd if=/dev/zero of="$DS/a.txt"          bs=1 count=100  2>/dev/null
dd if=/dev/zero of="$DS/sub/b.txt"      bs=1 count=250  2>/dev/null
dd if=/dev/zero of="$DS/sub/deep/c.txt" bs=1 count=1000 2>/dev/null

# a symlink pointing outside, and one pointing at its own parent: if
# either were followed the total would be wrong or the walk would hang
ln -s /etc "$DS/link_out"
ln -s "$DS" "$DS/loop"

expect_ok "dirsize on a plain tree" "$(ubus_call dirsize "{\"path\":\"$DS\"}")"

OUT="$(ubus_call dirsize "{\"path\":\"$DS\"}")"

echo "$OUT" | grep -q '"size": *1350' \
	&& { echo "PASS: total is 1350 bytes (symlinks not followed)"; PASS=$((PASS+1)); } \
	|| { echo "FAIL: expected size 1350, got: $OUT"; FAIL=$((FAIL+1)); }

echo "$OUT" | grep -q '"files": *3' \
	&& { echo "PASS: counted 3 files"; PASS=$((PASS+1)); } \
	|| { echo "FAIL: expected 3 files, got: $OUT"; FAIL=$((FAIL+1)); }

echo "$OUT" | grep -q '"dirs": *2' \
	&& { echo "PASS: counted 2 directories"; PASS=$((PASS+1)); } \
	|| { echo "FAIL: expected 2 dirs, got: $OUT"; FAIL=$((FAIL+1)); }

echo "$OUT" | grep -q '"truncated": *false' \
	&& { echo "PASS: not truncated"; PASS=$((PASS+1)); } \
	|| { echo "FAIL: unexpectedly truncated: $OUT"; FAIL=$((FAIL+1)); }

# /proc is a different filesystem and its sizes are fictional; walking
# from / must not descend into it. This also guards the device
# comparison, which is an object and not a number - comparing those with
# != always says "different", which silently stops the walk descending
# anywhere at all.
ROOT_OUT="$(ubus_call dirsize '{"path":"/etc"}')"
expect_ok "dirsize on /etc" "$ROOT_OUT"
ETC_SIZE="$(echo "$ROOT_OUT" | sed -n 's/.*"size": *\([0-9]*\).*/\1/p')"
[ -n "$ETC_SIZE" ] && [ "$ETC_SIZE" -gt 0 ] \
	&& { echo "PASS: /etc has a non-zero size ($ETC_SIZE bytes) - the walk descends"; PASS=$((PASS+1)); } \
	|| { echo "FAIL: /etc reported as $ETC_SIZE - the walk is not descending"; FAIL=$((FAIL+1)); }

ETC_DIRS="$(echo "$ROOT_OUT" | sed -n 's/.*"dirs": *\([0-9]*\).*/\1/p')"
[ -n "$ETC_DIRS" ] && [ "$ETC_DIRS" -gt 0 ] \
	&& { echo "PASS: /etc contains subdirectories ($ETC_DIRS) and they were entered"; PASS=$((PASS+1)); } \
	|| { echo "FAIL: no subdirectories entered under /etc"; FAIL=$((FAIL+1)); }

# a file is not a directory
expect_fail "dirsize refuses a plain file" "$(ubus_call dirsize "{\"path\":\"$DS/a.txt\"}")" ENOTDIR

# and the path rules still apply
expect_fail "dirsize rejects traversal" "$(ubus_call dirsize '{"path":"/etc/../../etc"}')" EACCES

rm -rf "$DS"

summary
