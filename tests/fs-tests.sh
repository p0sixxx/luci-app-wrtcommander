#!/bin/sh
# Functional filesystem tests against the "luci.filemanager" ubus
# object: create, mkdir, list, stat, read, write, rename, copy, move,
# delete, chmod - plus unicode, spaces, hidden files, long names and
# symlinks. Run make-testfs.sh first.

. "$(dirname "$0")/lib.sh"

[ -d "$TESTFS" ] || { echo "Run make-testfs.sh first" >&2; exit 1; }

echo "== Functional filesystem tests =="

expect_ok   "list $TESTFS"                    "$(ubus_call list "{\"path\":\"$TESTFS\"}")"
expect_ok   "stat file.txt"                   "$(ubus_call stat "{\"path\":\"$TESTFS/file.txt\"}")"
expect_ok   "read (preview) file.txt"         "$(ubus_call read "{\"path\":\"$TESTFS/file.txt\",\"mode\":\"preview\"}")"
expect_ok   "read русский.txt (unicode name)" "$(ubus_call read "{\"path\":\"$TESTFS/русский.txt\",\"mode\":\"preview\"}")"
expect_ok   "stat 'file with spaces.txt'"     "$(ubus_call stat "{\"path\":\"$TESTFS/file with spaces.txt\"}")"
expect_ok   "list shows hidden when asked"    "$(ubus_call list "{\"path\":\"$TESTFS\",\"show_hidden\":true}")"
LIST_HIDDEN="$(ubus_call list "{\"path\":\"$TESTFS\",\"show_hidden\":true}")"
echo "$LIST_HIDDEN" | grep -q '\.hidden' && { echo "PASS: hidden file .hidden is present when show_hidden=true"; PASS=$((PASS+1)); } \
	|| { echo "FAIL: .hidden missing from listing"; FAIL=$((FAIL+1)); }
LIST_NOHIDDEN="$(ubus_call list "{\"path\":\"$TESTFS\",\"show_hidden\":false}")"
echo "$LIST_NOHIDDEN" | grep -q '"\.hidden"' && { echo "FAIL: .hidden still present with show_hidden=false"; FAIL=$((FAIL+1)); } \
	|| { echo "PASS: .hidden filtered out when show_hidden=false"; PASS=$((PASS+1)); }

expect_ok   "stat symlink"                    "$(ubus_call stat "{\"path\":\"$TESTFS/symlink\"}")"
STAT_SYMLINK="$(ubus_call stat "{\"path\":\"$TESTFS/symlink\"}")"
echo "$STAT_SYMLINK" | grep -q '"is_symlink": *true' && { echo "PASS: symlink reported as is_symlink"; PASS=$((PASS+1)); } \
	|| { echo "FAIL: symlink not reported as is_symlink"; FAIL=$((FAIL+1)); }

expect_ok   "stat broken-symlink (stat succeeds even though target is gone)" "$(ubus_call stat "{\"path\":\"$TESTFS/broken-symlink\"}")"
STAT_BROKEN="$(ubus_call stat "{\"path\":\"$TESTFS/broken-symlink\"}")"
echo "$STAT_BROKEN" | grep -q '"broken": *true' && { echo "PASS: broken symlink flagged as broken"; PASS=$((PASS+1)); } \
	|| { echo "FAIL: broken symlink not flagged"; FAIL=$((FAIL+1)); }

expect_ok   "stat long file name"             "$(ubus_call stat "{\"path\":\"$TESTFS/this-is-a-deliberately-very-long-file-name-used-to-exercise-long-name-handling-in-the-listing-and-rename-dialogs-of-proton-file-manager.txt\"}")"

# create / mkdir
expect_ok   "create new empty file"           "$(ubus_call create "{\"path\":\"$TESTFS/created.txt\"}")"
expect_fail "create refuses existing file"    "$(ubus_call create "{\"path\":\"$TESTFS/created.txt\"}")" EEXIST
expect_ok   "mkdir new directory"             "$(ubus_call mkdir "{\"path\":\"$TESTFS/newdir\"}")"
expect_fail "mkdir refuses existing directory" "$(ubus_call mkdir "{\"path\":\"$TESTFS/newdir\"}")" EEXIST

# write / read round-trip (base64 of "hello proton")
expect_ok   "write to created.txt"            "$(ubus_call write "{\"path\":\"$TESTFS/created.txt\",\"data\":\"aGVsbG8gcHJvdG9u\",\"encoding\":\"base64\"}")"
READBACK="$(ubus_call read "{\"path\":\"$TESTFS/created.txt\",\"mode\":\"preview\"}")"
echo "$READBACK" | grep -q '"data": *"aGVsbG8gcHJvdG9u"' && { echo "PASS: write/read round-trip matches"; PASS=$((PASS+1)); } \
	|| { echo "FAIL: write/read round-trip mismatch"; echo "$READBACK" | sed 's/^/    /'; FAIL=$((FAIL+1)); }

# rename
expect_ok   "rename created.txt -> renamed.txt" "$(ubus_call rename "{\"path\":\"$TESTFS/created.txt\",\"name\":\"renamed.txt\"}")"
expect_fail "rename refuses to overwrite an existing name" "$(ubus_call rename "{\"path\":\"$TESTFS/renamed.txt\",\"name\":\"file.txt\"}")" EEXIST
expect_fail "rename rejects a name containing '/'" "$(ubus_call rename "{\"path\":\"$TESTFS/renamed.txt\",\"name\":\"a/b\"}")" EINVAL

# copy / move (bulk envelope)
expect_bulk_all_ok "copy renamed.txt into newdir"  "$(ubus_call copy "{\"items\":[\"$TESTFS/renamed.txt\"],\"destination\":\"$TESTFS/newdir\"}")"
expect_bulk_item_fail "copy refuses to overwrite without overwrite=true" \
	"$(ubus_call copy "{\"items\":[\"$TESTFS/renamed.txt\"],\"destination\":\"$TESTFS/newdir\"}")" EEXIST
expect_bulk_all_ok "copy with overwrite=true replaces the existing file" \
	"$(ubus_call copy "{\"items\":[\"$TESTFS/renamed.txt\"],\"destination\":\"$TESTFS/newdir\",\"overwrite\":true}")"
expect_bulk_item_fail "copy a directory into itself is rejected" \
	"$(ubus_call copy "{\"items\":[\"$TESTFS/newdir\"],\"destination\":\"$TESTFS/newdir\"}")" EINVAL

expect_bulk_all_ok "move directory/nested.txt into newdir" \
	"$(ubus_call move "{\"items\":[\"$TESTFS/directory/nested.txt\"],\"destination\":\"$TESTFS/newdir\"}")"
expect_ok "moved file exists at the new location" "$(ubus_call stat "{\"path\":\"$TESTFS/newdir/nested.txt\"}")"
expect_fail "old location is gone after move" "$(ubus_call stat "{\"path\":\"$TESTFS/directory/nested.txt\"}")" ENOENT

# chmod
expect_ok "chmod file.txt to 0644" "$(ubus_call chmod "{\"path\":\"$TESTFS/file.txt\",\"mode\":420}")"
CHMOD_STAT="$(ubus_call stat "{\"path\":\"$TESTFS/file.txt\"}")"
echo "$CHMOD_STAT" | grep -q '"mode_octal": *"0644"' && { echo "PASS: chmod applied (0644)"; PASS=$((PASS+1)); } \
	|| { echo "FAIL: chmod not applied"; echo "$CHMOD_STAT" | sed 's/^/    /'; FAIL=$((FAIL+1)); }

# delete (bulk)
expect_bulk_all_ok "delete a single file" "$(ubus_call remove "{\"paths\":[\"$TESTFS/newdir/nested.txt\"]}")"
expect_bulk_all_ok "delete a non-empty directory recursively" "$(ubus_call remove "{\"paths\":[\"$TESTFS/newdir\"]}")"
expect_fail "stat confirms the directory is really gone" "$(ubus_call stat "{\"path\":\"$TESTFS/newdir\"}")" ENOENT

# search
expect_ok "search for 'file' in the test root" "$(ubus_call search "{\"path\":\"$TESTFS\",\"query\":\"file\",\"recursive\":false}")"
expect_ok "recursive search for 'nested'" "$(ubus_call search "{\"path\":\"$TESTFS\",\"query\":\"nested\",\"recursive\":true}")"

# disk_info
expect_ok "disk_info for the test root" "$(ubus_call disk_info "{\"path\":\"$TESTFS\"}")"

summary
