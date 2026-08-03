#!/bin/sh
set -e

# /app/data is the writable persistence dir (relay-config.json + relay-logs.json).
# It may be a bind-mounted host directory owned by a different UID, or missing
# entirely on first run. Ensure it exists and is writable by the relay user
# before dropping privileges, so the server can auto-create and write back its
# config/logs.
mkdir -p /app/data
chown -R relay:relay /app/data

# Drop to the non-root relay user and start the server (CMD).
exec su-exec relay:relay "$@"
