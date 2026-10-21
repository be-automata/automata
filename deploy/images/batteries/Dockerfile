# syntax=docker/dockerfile:1.7
#
# The batteries image (ADR-013): ONE pinned image every agent run on the
# execution box starts from. Everything is installed the normal way, as on a
# developer laptop. Isolation is the container boundary, not uid fences.
#
# Build (from the repo root; the context is the worker's deploy dir, which
# holds the pinned lockfiles reused below):
#
#   docker buildx build --platform linux/amd64 \
#     -f deploy/images/batteries/Dockerfile \
#     -t automata-batteries:dev packages/worker/deploy
#
# Pinning rule: every download is fixed by version AND sha256 (or by commit
# sha), every npm closure by a committed lockfile, the base by digest, apt by
# an Ubuntu snapshot id. Bumping any of them is a reviewed change to this file.
# Most pins are copied from packages/worker/deploy/{batteries,harness}.json and
# cloud-init.yaml so the host model and this image run the same builds.
#
# No secrets: nothing here reads a token, and no build arg is a credential.
# The image is safe to publish.

# ── base ────────────────────────────────────────────────────────────────────
# ubuntu:24.04, the box's own distro, pinned by index digest (amd64 selected by
# --platform). The operator's reference starts from a Vercel sandbox image; we
# use the plain upstream base it is built on, so the box needs no extra registry.
FROM --platform=linux/amd64 ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

# ── pins ────────────────────────────────────────────────────────────────────
# apt: an Ubuntu snapshot (snapshot.ubuntu.com) freezes every .deb version.
# Empty string = the live archive (only for a local experiment, never for CI).
ARG APT_SNAPSHOT=20261015T000000Z

ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
ARG PNPM_VERSION=10.14.0
ARG PNPM_SHA256=b61ab8922a7d82794623460345964597d264c862a579b814eaa3468ac7b80375
# cloud-init.yaml CLAUDE_CODE_VERSION: the box and the image run the same agent.
ARG CLAUDE_CODE_VERSION=2.1.284
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386

# Dart >= 3.10 is required by the Somnio CLI; 3.13.5 is the tested version.
ARG DART_VERSION=3.13.5
ARG DART_SHA256=ea864bc64df30a6b8bdf30b2e32550f7717d9a890de8f40293aeabb924fe232b
# Flutter 3.47.7 bundles Dart 3.13.5, the same Dart as above.
ARG FLUTTER_VERSION=3.47.7
ARG FLUTTER_SHA256=af7455f540df951184c7953fbe3cf884766e7541dacf8571f9f582db03dd6230

# somnio-ai-tools: the commit batteries.json already pins (CLI v3.1.1). The
# operator's reference ref aa91cefe... is 5 commits BEHIND this one.
ARG SOMNIO_REF=aa53f071128a32bdafe4fbf77a7b0e0940b33db9
ARG SOMNIO_LOCK_SHA256=382a7234b0a98fd98ee5622193fe5632ef83d5ac3bd91056b080b423787e349d
ARG SOMNIO_VERSION_LINE="somnio v3.1.1"

ARG GSTACK_SHA=df89475b1713d2480a5e266e0fd448201817d80e
ARG BUN_VERSION=1.4.2
ARG BUN_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
ARG CHROMIUM_REVISION=1234
ARG CHROMIUM_VERSION=151.0.7922.34
ARG CHROMIUM_SHA256=ae8736ac28bc69278551500f219fc749575648263c43ec5990749eff43b9fcf8
ARG CHROMIUM_HEADLESS_SHA256=3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14

ARG GSD_VERSION=1.16.0
ARG GSD_LOCK_SHA256=21f19d078cf65e51b422fe623bc9cf0d5d3d3eef917415c73b671b4cb98b75af
ARG RUFLO_VERSION=3.56.7
ARG RUFLO_LOCK_SHA256=cfac0ec4433e1e58ca2208e4e5e2ba953af2b09f76d57579183de068f41c6e50
ARG BETTER_SQLITE3_PREBUILD_SHA256=99c43785639d5d3690c396ba245ee680ac8b469a46b19233a3546f0eb7f8e312
ARG MINILM_REV=751bff37182d3f1213fa05d7196b954e230abad9

ARG ACTIONLINT_VERSION=1.7.12
ARG ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG SHELLCHECK_VERSION=0.11.0
ARG SHELLCHECK_SHA256=b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6

# The runtime account. Fixed, non-root, outside every range the host uses
# (system 100-999, slot accounts 2000+), so a bind-mounted file's owner is never
# mistaken for a host account.
ARG AGENT_USER=agent
ARG AGENT_UID=10001

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# `fetch URL SHA256 OUT`: download, then refuse anything whose digest differs.
COPY --chmod=0755 <<'EOF' /usr/local/sbin/fetch-verified
#!/bin/bash
set -euo pipefail
url="$1" sha="$2" out="$3"
curl -fsSL --retry 3 --retry-delay 2 -o "$out" "$url"
echo "${sha}  ${out}" | sha256sum -c --quiet -
EOF

# ── system packages ─────────────────────────────────────────────────────────
# Chromium's runtime libraries are cloud-init.yaml's CHROMIUM_RUNTIME_PACKAGES.
# socat bridges the run's unix sockets (egress proxy, git broker, test Postgres)
# to the loopback ports the agent's tools expect (ADR-013 "egress").
#
# snapshot.ubuntu.com is https-only and the base image has no CA bundle, so
# ca-certificates is bootstrapped from the live (signed) archive first; the
# snapshot install below then moves it to the snapshot's version
# (--allow-downgrades), so the finished image holds snapshot packages only.
RUN snap=(); if [ -n "${APT_SNAPSHOT}" ]; then \
      apt-get update; apt-get install -y --no-install-recommends ca-certificates; \
      snap=(--snapshot "${APT_SNAPSHOT}" --allow-downgrades); \
    fi; \
    apt-get update "${snap[@]:0:2}"; \
    apt-get install -y --no-install-recommends "${snap[@]}" \
      ca-certificates curl git jq unzip xz-utils zip less procps file \
      python3 socat openssh-client build-essential \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 \
      libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 \
      libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
      libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
      libfontconfig1 libfreetype6 fonts-liberation; \
    rm -rf /var/lib/apt/lists/*

# ── Node 24 (official tarball, not NodeSource: no apt repo to trust) ────────
RUN fetch-verified "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      "${NODE_SHA256}" /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    npm config set --global fund false; npm config set --global update-notifier false

# ── single-binary CLIs ──────────────────────────────────────────────────────
RUN fetch-verified "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linuxstatic-x64" \
      "${PNPM_SHA256}" /usr/local/bin/pnpm; \
    chmod 0755 /usr/local/bin/pnpm; \
    fetch-verified "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      "${GH_SHA256}" /tmp/gh.tgz; \
    tar -xzf /tmp/gh.tgz -C /tmp; install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
    fetch-verified "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
      "${ACTIONLINT_SHA256}" /tmp/actionlint.tgz; \
    tar -xzf /tmp/actionlint.tgz -C /usr/local/bin actionlint; \
    fetch-verified "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
      "${GITLEAKS_SHA256}" /tmp/gitleaks.tgz; \
    tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks; \
    fetch-verified "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.gz" \
      "${SHELLCHECK_SHA256}" /tmp/shellcheck.tgz; \
    tar -xzf /tmp/shellcheck.tgz -C /tmp; install -m 0755 "/tmp/shellcheck-v${SHELLCHECK_VERSION}/shellcheck" /usr/local/bin/shellcheck; \
    chown root:root /usr/local/bin/actionlint /usr/local/bin/gitleaks; \
    rm -rf /tmp/*

# ── Claude Code CLI (exact version; same install line as cloud-init.yaml) ───
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    npm cache clean --force

# ── Dart SDK + Flutter SDK ──────────────────────────────────────────────────
# Both on PATH; /opt/dart-sdk/bin comes first, so `dart` is the standalone SDK
# (identical version to Flutter's bundled one). Flutter and the pub cache are
# owned by the runtime user because Flutter writes its own bin/cache lock and
# `pub get` writes PUB_CACHE on every run.
ENV PUB_CACHE=/opt/pub-cache \
    FLUTTER_ROOT=/opt/flutter \
    FLUTTER_SUPPRESS_ANALYTICS=true \
    DART_SUPPRESS_ANALYTICS=true \
    CI=true \
    PATH=/opt/dart-sdk/bin:/opt/pub-cache/bin:/opt/flutter/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
RUN fetch-verified "https://storage.googleapis.com/dart-archive/channels/stable/release/${DART_VERSION}/sdk/dartsdk-linux-x64-release.zip" \
      "${DART_SHA256}" /tmp/dart.zip; \
    unzip -q /tmp/dart.zip -d /opt; rm /tmp/dart.zip; chmod -R a+rX /opt/dart-sdk; \
    fetch-verified "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz" \
      "${FLUTTER_SHA256}" /tmp/flutter.tar.xz; \
    tar -xJf /tmp/flutter.tar.xz -C /opt --no-same-owner; rm /tmp/flutter.tar.xz; \
    git config --system --add safe.directory /opt/flutter; \
    mkdir -p /opt/pub-cache

# ── the runtime account ─────────────────────────────────────────────────────
RUN useradd --create-home --home-dir "/home/${AGENT_USER}" --shell /bin/bash \
      --uid "${AGENT_UID}" --user-group "${AGENT_USER}"; \
    chown -R "${AGENT_USER}:${AGENT_USER}" /opt/flutter /opt/pub-cache; \
    mkdir -p /workspace /opt/automata /opt/ms-playwright; \
    chown "${AGENT_USER}:${AGENT_USER}" /workspace

# ── Somnio CLI + every catalog skill ────────────────────────────────────────
# The pinned commit, its CLI resolved against the committed lockfile overlay
# (upstream ships no pubspec.lock, so `pub global activate -sgit` alone would
# float every transitive dependency). SOMNIO_ROOT closes the CLI's last-resort
# "walk up from the cwd" root lookup, which would otherwise trust a checkout
# that plants skills/ + agent-rules/ + cli/pubspec.yaml.
ENV SOMNIO_ROOT=/opt/somnio-ai-tools
COPY batteries/somnio-cli/pubspec.lock /tmp/somnio-pubspec.lock
RUN echo "${SOMNIO_LOCK_SHA256}  /tmp/somnio-pubspec.lock" | sha256sum -c --quiet -; \
    git init -q "${SOMNIO_ROOT}"; \
    git -C "${SOMNIO_ROOT}" -c protocol.version=2 fetch -q --depth 1 \
      https://github.com/somnio-software/somnio-ai-tools.git "${SOMNIO_REF}"; \
    git -C "${SOMNIO_ROOT}" checkout -q --detach FETCH_HEAD; \
    test "$(git -C "${SOMNIO_ROOT}" rev-parse HEAD)" = "${SOMNIO_REF}"; \
    rm -rf "${SOMNIO_ROOT}/.git"; \
    install -m 0644 /tmp/somnio-pubspec.lock "${SOMNIO_ROOT}/cli/pubspec.lock"; \
    rm /tmp/somnio-pubspec.lock; \
    chown -R "${AGENT_USER}:${AGENT_USER}" "${SOMNIO_ROOT}"

# ── npm-locked harness closures: GSD and ruflo ──────────────────────────────
# The same package.json + package-lock.json the host batteries install from,
# checksum-verified, installed with `npm ci` into root-owned, read-only dirs.
COPY batteries/gsd/package.json batteries/gsd/package-lock.json /opt/automata/gsd/
COPY batteries/ruflo/package.json batteries/ruflo/package-lock.json /opt/automata/ruflo/
RUN echo "${GSD_LOCK_SHA256}  /opt/automata/gsd/package-lock.json" | sha256sum -c --quiet -; \
    echo "${RUFLO_LOCK_SHA256}  /opt/automata/ruflo/package-lock.json" | sha256sum -c --quiet -; \
    (cd /opt/automata/gsd && npm ci --omit=dev --ignore-scripts --no-audit); \
    (cd /opt/automata/ruflo && npm ci --omit=dev --ignore-scripts --no-audit \
      && npm rebuild @claude-flow/cli); \
    fetch-verified "https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/better-sqlite3-v12.11.1-node-v137-linux-x64.tar.gz" \
      "${BETTER_SQLITE3_PREBUILD_SHA256}" /tmp/bsq.tgz; \
    tar -xzf /tmp/bsq.tgz -C /opt/automata/ruflo/node_modules/better-sqlite3 build/Release/better_sqlite3.node; \
    m=/opt/automata/ruflo/node_modules/@huggingface/transformers/.cache/Xenova/all-MiniLM-L6-v2; \
    hf="https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/${MINILM_REV}"; \
    mkdir -p "$m/onnx"; \
    fetch-verified "$hf/config.json" 7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7 "$m/config.json"; \
    fetch-verified "$hf/tokenizer.json" da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0 "$m/tokenizer.json"; \
    fetch-verified "$hf/tokenizer_config.json" 9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3 "$m/tokenizer_config.json"; \
    fetch-verified "$hf/onnx/model.onnx" 759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e "$m/onnx/model.onnx"; \
    ln -s /opt/automata/ruflo/node_modules/ruflo/bin/ruflo.js /usr/local/bin/ruflo; \
    chmod -R a+rX,go-w /opt/automata; \
    npm cache clean --force; rm -rf /tmp/*

# ── gstack's pinned Chromium builds (Playwright layout, marked complete) ────
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN cft="https://cdn.playwright.dev/builds/cft/${CHROMIUM_VERSION}/linux64"; \
    fetch-verified "$cft/chrome-linux64.zip" "${CHROMIUM_SHA256}" /tmp/chrome.zip; \
    fetch-verified "$cft/chrome-headless-shell-linux64.zip" "${CHROMIUM_HEADLESS_SHA256}" /tmp/shell.zip; \
    mkdir -p "/opt/ms-playwright/chromium-${CHROMIUM_REVISION}" "/opt/ms-playwright/chromium_headless_shell-${CHROMIUM_REVISION}"; \
    unzip -q /tmp/chrome.zip -d "/opt/ms-playwright/chromium-${CHROMIUM_REVISION}"; \
    unzip -q /tmp/shell.zip -d "/opt/ms-playwright/chromium_headless_shell-${CHROMIUM_REVISION}"; \
    : >"/opt/ms-playwright/chromium-${CHROMIUM_REVISION}/INSTALLATION_COMPLETE"; \
    : >"/opt/ms-playwright/chromium_headless_shell-${CHROMIUM_REVISION}/INSTALLATION_COMPLETE"; \
    chmod -R a+rX /opt/ms-playwright; rm -f /tmp/*.zip

# bun for gstack's setup and its browse binary.
RUN fetch-verified "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
      "${BUN_SHA256}" /tmp/bun.zip; \
    unzip -q /tmp/bun.zip -d /tmp; install -m 0755 /tmp/bun-linux-x64/bun /usr/local/bin/bun; \
    rm -rf /tmp/bun*

# ── everything that installs INTO the agent's HOME runs as the agent ────────
# No upstream setup code runs as root (the same rule install-batteries.sh keeps).
USER ${AGENT_USER}
WORKDIR /home/${AGENT_USER}
ENV HOME=/home/${AGENT_USER} \
    GSTACK_SESSION_KIND=spawned \
    MCP_TIMEOUT=30000

# Flutter: first run unpacks its tool snapshot; analytics off for good.
RUN flutter config --no-analytics --no-cli-animations >/dev/null; \
    flutter --version; dart --disable-analytics

# Somnio: resolve against the lock, activate from the path, install EVERY
# catalog skill globally for Claude. Agent rules are per-project only for
# Claude (the CLI refuses --global), so they ship as source under SOMNIO_ROOT
# and the run decides whether to install them (ADR-013 open question).
RUN cd "${SOMNIO_ROOT}/cli"; \
    dart pub get --enforce-lockfile; \
    dart pub global activate --source path "${SOMNIO_ROOT}/cli"; \
    test "$(somnio --version | tail -n 1)" = "${SOMNIO_VERSION_LINE}"; \
    cd "$HOME"; \
    somnio skills install --agent claude --all-skills --global

# gstack: the pinned commit, its own setup, telemetry and update checks off.
RUN co="$HOME/.claude/skills/gstack"; \
    mkdir -p "$co"; \
    git -c core.hooksPath=/dev/null init -q "$co"; \
    git -C "$co" -c core.hooksPath=/dev/null -c protocol.version=2 fetch -q --depth 1 \
      https://github.com/garrytan/gstack "${GSTACK_SHA}"; \
    git -C "$co" -c core.hooksPath=/dev/null checkout -q --detach FETCH_HEAD; \
    test "$(git -C "$co" rev-parse HEAD)" = "${GSTACK_SHA}"; \
    "$co/bin/gstack-config" set telemetry off; \
    "$co/bin/gstack-config" set update_check false; \
    GSTACK_SKIP_ASIDE=1 "$co/setup" --host claude </dev/null; \
    test -z "$(git -C "$co" status --porcelain --untracked-files=no)"; \
    rm -f "$HOME"/.claude/skills/*/.gstack-owned

# GSD: its own installer, into the agent's Claude config dir.
RUN node /opt/automata/gsd/node_modules/@opengsd/gsd-core/bin/install.js \
      --claude --global --config-dir "$HOME/.claude" --portable-hooks --no-legacy-cleanup; \
    rm -rf "$HOME/.claude/.gsd-source" "$HOME/.claude/.gsd-staging"

# The image carries no Claude settings, trust seed, MCP registration or
# credential: those are per-run, per-lane policy the worker copies in before
# the container starts (ADR-013 "run HOME" and "review-lane fence").
WORKDIR /workspace

LABEL org.opencontainers.image.title="automata-batteries" \
      org.opencontainers.image.description="Pinned agent-run image for the execution box (ADR-013)" \
      org.opencontainers.image.source="https://github.com/be-automata/automata" \
      org.opencontainers.image.licenses="MIT"

CMD ["bash"]
