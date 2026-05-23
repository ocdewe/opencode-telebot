#!/bin/bash

set -e

REPO_DIR="/root/telegram-remote"

printf 'Recovery files:\n'
printf -- '- %s\n' "$REPO_DIR/README.md"
printf -- '- %s\n' "$REPO_DIR/MEMORY.md"
printf -- '- %s\n' "$REPO_DIR/HEARTBEAT.md"
printf -- '- %s\n' "$REPO_DIR/RESTORE-CHECKLIST.md"
printf -- '- %s\n' "$REPO_DIR/SERVICE-STATUS.md"
printf -- '- %s\n' "$REPO_DIR/.env.example"
