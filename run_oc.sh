#!/bin/bash
export PATH=/root/.opencode/bin:/usr/bin:/usr/local/bin:/bin
OUTFILE="$1"
shift
/root/.opencode/bin/opencode "$@" > "$OUTFILE" 2>/dev/null
