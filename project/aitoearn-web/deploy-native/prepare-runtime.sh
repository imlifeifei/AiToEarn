#!/bin/sh
set -eu
cd /opt/aitoearn/project/aitoearn-web
if [ ! -s .next/standalone/server.js ] || [ ! -s .next/BUILD_ID ]; then
  echo 'Production build missing; run the documented locked install and build first.' >&2
  exit 1
fi
mkdir -p .next/standalone/.next
cp -a public .next/standalone/
cp -a .next/static .next/standalone/.next/
printf '%s\n' 'Native standalone runtime prepared at .next/standalone.'
