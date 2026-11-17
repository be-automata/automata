# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# The cell guest image (ADR-014, #656): the ADR-013 batteries image plus the
# daemon bundle and two small static scripts. A cell cannot bind-mount and has
# no copy-in and no stdin, so everything the cell needs is baked here.
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
FROM --platform=linux/amd64 ghcr.io/be-automata/automata-batteries@sha256:da029c443bfba5d61f67fdee4f5596ba1bfc6aff7653a46fa858a6b3cdfffffc

ARG REVISION=unknown
# Root only for COPY ownership; nothing upstream runs here.
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
      org.opencontainers.image.base.name="ghcr.io/be-automata/automata-batteries@sha256:da029c443bfba5d61f67fdee4f5596ba1bfc6aff7653a46fa858a6b3cdfffffc"
