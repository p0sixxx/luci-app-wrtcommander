#!/bin/sh
# Runs the row-interaction test for the LuCI view. It drives the real
# view module in a headless browser, so it needs node and playwright and
# is a workstation test, not a router one - on a router it skips.
#
#   sh ui-click-tests.sh
#   PLAYWRIGHT=/path/to/playwright CHROMIUM=/path/to/chrome sh ui-click-tests.sh

cd "$(dirname "$0")" || exit 1

NODE="${NODE:-$(command -v node || true)}"
if [ -z "$NODE" ]; then
	echo "SKIP: no node found (workstation-only test)"
	exit 0
fi
if ! "$NODE" -e "require('${PLAYWRIGHT:-playwright}')" 2>/dev/null; then
	echo "SKIP: playwright not installed (workstation-only test)"
	exit 0
fi

echo "== View interaction tests =="
"$NODE" ui-click-test.js
