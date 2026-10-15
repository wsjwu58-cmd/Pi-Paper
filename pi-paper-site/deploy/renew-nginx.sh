#!/bin/sh
set -eu
if [ "${RENEWED_LINEAGE:-}" = '/etc/letsencrypt/live/wsjaly.cn' ]; then
    /usr/bin/nginx -t
    /usr/bin/nginx -s reload
fi
