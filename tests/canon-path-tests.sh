#!/bin/sh
# Runs the path-validation regression test. Like the upload handler test
# this one needs neither a router nor a running rpcd - it lifts canon()
# and detect_binary() out of the backend and calls them directly - so it
# is equally useful from a workstation that has ucode installed.
#
#   sh canon-path-tests.sh
#   UCODE=/path/to/ucode sh canon-path-tests.sh     # non-standard build

cd "$(dirname "$0")" || exit 1

UC="${UCODE:-$(command -v ucode || true)}"
if [ -z "$UC" ]; then
	echo "SKIP: no ucode interpreter found"
	exit 0
fi

echo "== Path validation tests =="
"$UC" ${UCODE_LIB:+-L "$UCODE_LIB"} canon-path-test.uc
