# Synapse for The Bazaar — wraps the upstream image, mounts our config,
# and runs envsubst at startup so Railway env vars land in homeserver.yaml.

FROM matrixdotorg/synapse:latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends gettext-base && rm -rf /var/lib/apt/lists/*

COPY homeserver.yaml /etc/synapse/homeserver.template.yaml
COPY log.yaml         /data/log.yaml
COPY entrypoint.sh    /usr/local/bin/bazaar-entrypoint.sh
RUN chmod +x /usr/local/bin/bazaar-entrypoint.sh

USER 991:991
ENTRYPOINT ["/usr/local/bin/bazaar-entrypoint.sh"]
