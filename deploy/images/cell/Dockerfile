# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# The cell guest image (ADR-014, #656): the ADR-013 batteries image plus the
# daemon bundle, two small static scripts and the Postgres 16 server for the
# cell's test database (#707). A cell cannot bind-mount and has no copy-in and
# no stdin, so everything the cell needs is baked here.
#
# OpenSandbox replaces this image's ENTRYPOINT and CMD with its own bootstrap
# and runs the request `entrypoint` instead, so none is set here.
#
# Build from a staged context (CI does this in $RUNNER_TEMP/cell-ctx):
#   cell-ctx/{Dockerfile,cell-entry.sh,cell-send.sh,daemon/index.js}
#   docker buildx build --platform linux/amd64 --build-arg REVISION=<sha> \
#     -t automata-cell:ci --load cell-ctx
#
# No secrets: no build arg is a credential, and the daemon token is never in
# the image, its layers or its env. The daemon takes the token from each
# message; the sidecar vault swaps the placeholder on the wire.
FROM --platform=linux/amd64 ghcr.io/be-automata/automata-batteries@sha256:cfd893435d46d2165e090286c02af3b33d61afb6265e4b340c636a473cf89640

ARG REVISION=unknown
# apt: the batteries image's Ubuntu snapshot, so every .deb version is frozen.
ARG APT_SNAPSHOT=20261015T000000Z

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

USER root
# The cell's test database (#707, OD-2): the Postgres 16 server the box runs
# (install-test-postgres.sh), and the one RUN in this image. No default
# cluster: a cell run of a TEST_SERVICES_REPOS repo starts its own, as uid
# 10001 under /tmp (packages/worker/src/agent-run/cell-test-db.ts). ssl-cert's
# postinst generates a snakeoil key pair, which a cell never uses: removed, so
# no private key sits in a layer.
# The CA store (#724): OpenSandbox's bootstrap installs the egress sidecar's
# MITM CA with `update-ca-certificates`, which as uid 10001 needs write access
# to /usr/local/share/ca-certificates (the copy) and /etc/ssl/certs (the links
# and the rebuilt bundle). Dart and Flutter read ONLY the system store, so
# without this `dart pub get` fails CERTIFICATE_VERIFY_FAILED. Exactly those
# two directories are chowned to agent, not recursive, nothing else under
# /etc/ssl, /etc/ca-certificates or /usr/share/ca-certificates. Safe for the
# reason in README "TLS in the cell": trust is enforced by the sidecar outside
# the guest, and uid 10001 can already run anything inside the cell.
# python3-pip + python3-venv (#716): the batteries image installs them too, but
# the base digest above predates that; once the FROM is bumped past it, this
# install is a no-op and the two names can go.
RUN mkdir -p /etc/postgresql-common/createcluster.d; \
    echo 'create_main_cluster = false' >/etc/postgresql-common/createcluster.d/automata-cell.conf; \
    snap=(); if [ -n "${APT_SNAPSHOT}" ]; then snap=(--snapshot "${APT_SNAPSHOT}"); fi; \
    apt-get update --error-on=any "${snap[@]}"; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${snap[@]}" postgresql-16 python3-pip python3-venv; \
    rm -f /etc/ssl/private/ssl-cert-snakeoil.key /etc/ssl/certs/ssl-cert-snakeoil.pem; \
    chown agent:agent /etc/ssl/certs /usr/local/share/ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    test -x /usr/lib/postgresql/16/bin/initdb; \
    test ! -e /var/lib/postgresql/16/main

# Still root, for COPY ownership; the image ends as agent below.
# The bundle goes into /opt/automata, which the base already has (0755). A COPY
# --chmod into a NEW directory creates that directory without search permission
# for uid 10001 (measured: `statx … Permission denied` in the cell-image run).
COPY --chown=root:root --chmod=0444 daemon/index.js /opt/automata/daemon.js
COPY --chown=root:root --chmod=0555 cell-entry.sh /opt/automata/cell-entry.sh
COPY --chown=root:root --chmod=0555 cell-send.sh  /opt/automata/cell-send.sh

ENV OPENSANDBOX_MERGED_CA_PATH=/home/agent/.opensandbox/merged-ca-certificates.pem \
    GIT_SSL_CAINFO=/home/agent/.opensandbox/merged-ca-certificates.pem \
    PATH=/home/agent/.automata-run/flutter-pin:/opt/flutter/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin

USER agent
WORKDIR /workspace

LABEL org.opencontainers.image.title="automata-cell" \
      org.opencontainers.image.description="Guest image for OpenSandbox cells (#656): batteries + daemon bundle" \
      org.opencontainers.image.source="https://github.com/be-automata/automata" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.base.name="ghcr.io/be-automata/automata-batteries@sha256:cfd893435d46d2165e090286c02af3b33d61afb6265e4b340c636a473cf89640"
