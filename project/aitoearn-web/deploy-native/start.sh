#!/bin/sh
set -eu
cd /opt/aitoearn/project/aitoearn-web/.next/standalone
# Never deliver a shared administrator bearer token to public visitors.
unset AUTO_LOGIN_TOKEN
export NODE_ENV=production
export NEXT_TELEMETRY_DISABLED=1
export HOSTNAME=127.0.0.1
export PORT="${PORT:-3000}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}"
export NEXT_PUBLIC_API_URL=/api
export NEXT_PUBLIC_HOST_URL=https://earn.dielianhua.cc
exec node server.js
