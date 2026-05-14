#!/bin/sh
# Resolve env into config and start Synapse. The signing key is generated
# on first boot if absent.

set -eu

mkdir -p /data
[ -f /data/signing.key ] || python -m synapse.app.homeserver \
    --server-name "${SYNAPSE_SERVER_NAME}" \
    --config-path /data/homeserver.yaml \
    --generate-keys || true

envsubst < /etc/synapse/homeserver.template.yaml > /data/homeserver.yaml

exec python -m synapse.app.homeserver --config-path /data/homeserver.yaml
