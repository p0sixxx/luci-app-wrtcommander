#!/bin/sh
# Creates the minimal on-router test filesystem under /tmp. All
# destructive tests run against this tree, never against real /etc or
# other system paths, per the "test mode" requirement.
set -e

TESTFS="/tmp/wrtcommander-test"

rm -rf "$TESTFS"
mkdir -p "$TESTFS/directory"

printf 'hello world\n' > "$TESTFS/file.txt"
printf '\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82 \xd0\xbc\xd0\xb8\xd1\x80\n' > "$TESTFS/русский.txt"
printf 'has spaces\n' > "$TESTFS/file with spaces.txt"
printf 'i am hidden\n' > "$TESTFS/.hidden"
printf 'a very long file name that exercises name-length handling in the UI and backend alike.txt' > "$TESTFS/this-is-a-deliberately-very-long-file-name-used-to-exercise-long-name-handling-in-the-listing-and-rename-dialogs-of-wrtcommander.txt"
printf 'nested one\n' > "$TESTFS/directory/nested.txt"
printf 'nested two\n' > "$TESTFS/directory/second.txt"

ln -sf file.txt "$TESTFS/symlink"
ln -sf /nonexistent-target-xyz "$TESTFS/broken-symlink"

# ~640 KiB file: bigger than the default 512 KiB preview_max_size, to
# exercise the "too large for preview" / head / tail code paths
awk 'BEGIN { for (i = 0; i < 15000; i++) print "line " i " 0123456789012345678901234567890123456789" }' > "$TESTFS/large.txt"

echo "Test filesystem created at $TESTFS:"
ls -la "$TESTFS"
