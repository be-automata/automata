# syntax=docker/dockerfile:1.7
#
# The batteries image (ADR-013): ONE pinned image every agent run on the
# execution box starts from. Everything is installed the normal way, as on a
# developer laptop. Isolation is the container boundary, not uid fences.
#
# Build (from the repo root; the context is this directory, which holds the
# pinned lockfiles reused below under gsd/, ruflo/ and somnio-cli/):
#
#   docker buildx build --platform linux/amd64 \
#     -f deploy/images/batteries/Dockerfile \
#     -t automata-batteries:dev deploy/images/batteries
#
# Pinning rule: every download is fixed by version AND sha256 (or by commit
# sha), every npm closure by a committed lockfile, the base by digest, apt by
# an Ubuntu snapshot id. Bumping any of them is a reviewed change to this file.
# The pins were first copied from the host-model battery manifests, deleted
# with the host path in the ADR-013 release PR; this file is now their source.
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
ARG CLAUDE_CODE_VERSION=2.1.284
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386

# Flutter 3.47.7 bundles Dart 3.13.5, the ONLY Dart in the image (ADR-013: no
# standalone SDK). The Somnio CLI needs Dart >= 3.10.
ARG FLUTTER_VERSION=3.47.7
ARG FLUTTER_SHA256=af7455f540df951184c7953fbe3cf884766e7541dacf8571f9f582db03dd6230

# somnio-ai-tools: CLI v3.1.1. The
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

# be-automata/vendor-runtime-skills: vendor skills, agents and commands prepared
# for this runtime (public; its catalog.json says what to link). The commit sha
# pins every file of it; the upstream vendor's own pins (commit, tree ids) are
# recorded in vendors/<vendor>/VENDOR.json, checked when the catalog imports.
ARG VENDOR_SKILLS_SHA=24c77e7d2f178e9074514a8405f6d375dc7ec704
# ruflo's planner and refinement agents (dev-execution spawns them), by sha256.
ARG RUFLO_PLANNER_SHA256=3746140c2bdfb38b3a26827e6c13745dff0999a5cd54767aaa984372f2573f89
ARG RUFLO_REFINEMENT_SHA256=67ca9278c63971268226cc1096646459d78f6cad58274adfb6eda8d24a846862

ARG GSD_VERSION=1.16.0
ARG GSD_LOCK_SHA256=21f19d078cf65e51b422fe623bc9cf0d5d3d3eef917415c73b671b4cb98b75af
ARG RUFLO_VERSION=3.56.7
ARG RUFLO_LOCK_SHA256=cfac0ec4433e1e58ca2208e4e5e2ba953af2b09f76d57579183de068f41c6e50
# better-sqlite3's prebuild for Node 24's ABI (node-v137), the version ruflo's lock resolves.
ARG BETTER_SQLITE3_VERSION=12.11.1
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
curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 -o "$out" "$url"
echo "${sha}  ${out}" | sha256sum -c --quiet -
EOF

# ── system packages ─────────────────────────────────────────────────────────
# Chromium's runtime libraries: Playwright's `install-deps chromium` list for
# ubuntu24.04-x64, plus fonts.
# socat bridges the run's unix sockets (egress proxy, git broker, test Postgres)
# to the loopback ports the agent's tools expect (ADR-013 "egress").
#
# snapshot.ubuntu.com is https-only and the base image has no CA bundle, so
# ca-certificates is bootstrapped from the live (signed) archive first; the
# snapshot install below then moves it to the snapshot's version
# (--allow-downgrades), so the finished image holds snapshot packages only.
# The snapshot host drops connections and answers 502/503 under load: apt
# retries each fetch, and a missing index fails the update here instead of
# surfacing later as "no installation candidate".
RUN echo 'Acquire::Retries "8";' >/etc/apt/apt.conf.d/80-retries; \
    snap=(); if [ -n "${APT_SNAPSHOT}" ]; then \
      apt-get update; apt-get install -y --no-install-recommends ca-certificates; \
      snap=(--snapshot "${APT_SNAPSHOT}" --allow-downgrades); \
    fi; \
    apt-get update --error-on=any "${snap[@]:0:2}"; \
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

# ── Claude Code CLI (exact version) ─────────────────────────────────────────
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    npm cache clean --force

# ── the runtime account ─────────────────────────────────────────────────────
# Created before the SDKs so their ownership is set in the SAME layer that
# extracts them (a later `chown -R` would copy the 2.5 GB Flutter tree into a
# second layer).
RUN useradd --create-home --home-dir "/home/${AGENT_USER}" --shell /bin/bash \
      --uid "${AGENT_UID}" --user-group "${AGENT_USER}"; \
    mkdir -p /workspace; \
    chown "${AGENT_USER}:${AGENT_USER}" /workspace

# ── Flutter SDK (and its bundled Dart) ──────────────────────────────────────
# `dart` on PATH is Flutter's own (/opt/flutter/bin/dart). Flutter is owned by
# the runtime user because it writes stamps and a lock under bin/cache on every
# invocation; with a read-only rootfs a run mounts /opt/flutter as a per-run
# volume (ADR-013 "read-only rootfs"). PUB_CACHE lives in the writable HOME.
ENV PUB_CACHE=/home/${AGENT_USER}/.pub-cache \
    FLUTTER_ROOT=/opt/flutter \
    FLUTTER_SUPPRESS_ANALYTICS=true \
    DART_SUPPRESS_ANALYTICS=true \
    CI=true \
    PATH=/opt/flutter/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
RUN fetch-verified "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${FLUTTER_VERSION}-stable.tar.xz" \
      "${FLUTTER_SHA256}" /tmp/flutter.tar.xz; \
    tar -xJf /tmp/flutter.tar.xz -C /opt --no-same-owner; rm /tmp/flutter.tar.xz; \
    git config --system --add safe.directory /opt/flutter; \
    chown -R "${AGENT_USER}:${AGENT_USER}" /opt/flutter

# ── Somnio CLI + every catalog skill ────────────────────────────────────────
# The pinned commit, its CLI resolved against the committed lockfile overlay
# (upstream ships no pubspec.lock, so `pub global activate -sgit` alone would
# float every transitive dependency). SOMNIO_ROOT closes the CLI's last-resort
# "walk up from the cwd" root lookup, which would otherwise trust a checkout
# that plants skills/ + agent-rules/ + cli/pubspec.yaml.
ENV SOMNIO_ROOT=/opt/somnio-ai-tools
COPY somnio-cli/pubspec.lock /tmp/somnio-pubspec.lock
RUN echo "${SOMNIO_LOCK_SHA256}  /tmp/somnio-pubspec.lock" | sha256sum -c --quiet -; \
    git init -q "${SOMNIO_ROOT}"; \
    git -C "${SOMNIO_ROOT}" -c protocol.version=2 fetch -q --depth 1 \
      https://github.com/somnio-software/somnio-ai-tools.git "${SOMNIO_REF}"; \
    git -C "${SOMNIO_ROOT}" checkout -q --detach FETCH_HEAD; \
    test "$(git -C "${SOMNIO_ROOT}" rev-parse HEAD)" = "${SOMNIO_REF}"; \
    rm -rf "${SOMNIO_ROOT}/.git"; \
    install -m 0644 /tmp/somnio-pubspec.lock "${SOMNIO_ROOT}/cli/pubspec.lock"; \
    rm /tmp/somnio-pubspec.lock; \
    chown -R "${AGENT_USER}:${AGENT_USER}" "${SOMNIO_ROOT}"; \
    ln -s "${SOMNIO_ROOT}/somnio" /usr/local/bin/somnio

# ── npm-locked harness closures: GSD and ruflo ──────────────────────────────
# The committed package.json + package-lock.json, checksum-verified, installed
# into root-owned, read-only dirs. `npm install` against the lock, not
# `npm ci`: ruflo's lock omits optional platform packages never published for
# other platforms, which `npm ci` refuses. The lock is re-checked afterwards.
COPY gsd/package.json gsd/package-lock.json /opt/automata/gsd/
COPY ruflo/package.json ruflo/package-lock.json /opt/automata/ruflo/
RUN echo "${GSD_LOCK_SHA256}  /opt/automata/gsd/package-lock.json" | sha256sum -c --quiet -; \
    echo "${RUFLO_LOCK_SHA256}  /opt/automata/ruflo/package-lock.json" | sha256sum -c --quiet -; \
    (cd /opt/automata/gsd && npm install --ignore-scripts --no-save --no-audit --no-fund); \
    (cd /opt/automata/ruflo && npm install --ignore-scripts --no-save --no-audit --no-fund \
      && npm_config_ignore_scripts=false npm rebuild @claude-flow/cli --foreground-scripts); \
    echo "${GSD_LOCK_SHA256}  /opt/automata/gsd/package-lock.json" | sha256sum -c --quiet -; \
    echo "${RUFLO_LOCK_SHA256}  /opt/automata/ruflo/package-lock.json" | sha256sum -c --quiet -; \
    fetch-verified "https://github.com/WiseLibs/better-sqlite3/releases/download/v${BETTER_SQLITE3_VERSION}/better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v137-linux-x64.tar.gz" \
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

# ── Vendor runtime skills (be-automata/vendor-runtime-skills, by commit) ──
# Plain runtime content: no plugin wiring, no hooks, no MCP servers. ENV cannot
# be read from catalog.json at build time, so the vendor env is declared here
# and the build fails if the catalog says otherwise. `ytctl` is the vendor's
# shim: agents hold YOUTRACK_AGENT_TOKEN, the vendor's ytctl reads YOUTRACK_TOKEN.
ENV VENDOR_SKILLS_ROOT=/opt/vendor-runtime-skills
ENV CLAUDE_PLUGIN_ROOT=${VENDOR_SKILLS_ROOT}/vendors/somnio \
    YTCTL=${VENDOR_SKILLS_ROOT}/vendors/somnio/bin/ytctl
# shellcheck disable=SC2016 # jq programs, not shell expansions
RUN d="${VENDOR_SKILLS_ROOT}"; \
    git init -q "$d"; \
    git -C "$d" -c core.hooksPath=/dev/null -c protocol.version=2 \
      fetch -q --depth 1 https://github.com/be-automata/vendor-runtime-skills.git "${VENDOR_SKILLS_SHA}"; \
    git -C "$d" -c core.hooksPath=/dev/null checkout -q --detach FETCH_HEAD; \
    test "$(git -C "$d" rev-parse HEAD)" = "${VENDOR_SKILLS_SHA}"; \
    rm -rf "$d/.git"; \
    c="$d/catalog.json"; \
    test "$(jq -r '.vendors | keys | join(",")' "$c")" = somnio; \
    test "$(jq -r '.vendors.somnio | .root, (.env | to_entries | map("\(.key)=\(.value)") | join(" ")), (.pathDirs | join(" "))' "$c" | paste -sd'|')" \
      = 'vendors/somnio|CLAUDE_PLUGIN_ROOT={{root}} YTCTL={{root}}/bin/ytctl|{{root}}/bin'; \
    test -x "${YTCTL}"; ln -s "${YTCTL}" /usr/local/bin/ytctl; \
    chown -R root:root "$d"; chmod -R a+rX,go-w "$d"

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
# No upstream setup code runs as root.
USER ${AGENT_USER}
WORKDIR /home/${AGENT_USER}
ENV HOME=/home/${AGENT_USER} \
    GSTACK_SESSION_KIND=spawned \
    MCP_TIMEOUT=30000

# Flutter: first run unpacks its tool snapshot; analytics off for good.
RUN flutter config --no-analytics --no-cli-animations >/dev/null; \
    flutter --version; dart --disable-analytics

# Somnio: resolve against the lock, compile ahead of time, install EVERY
# catalog skill globally for Claude. AOT, not `pub global activate`: an
# activated binstub re-resolves dependencies at start and fails offline (the
# run has --network none); the compiled CLI finds its content via SOMNIO_ROOT,
# so the pub cache it resolved into is emptied afterwards. Agent rules are per-project
# only for Claude (the CLI refuses --global): every run installs them into its
# checkout (ADR-013 "run path").
RUN cd "${SOMNIO_ROOT}/cli"; \
    dart pub get --enforce-lockfile; \
    dart compile exe bin/somnio.dart -o "${SOMNIO_ROOT}/somnio"; \
    rm -rf "${SOMNIO_ROOT}/cli/.dart_tool" "${PUB_CACHE:?}"; \
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
    rm -f "$HOME"/.claude/skills/*/.gstack-owned; \
    rm -rf "$HOME/.bun/install/cache"

# GSD: its own installer, into the agent's Claude config dir.
#
# The image carries no Claude settings, trust seed, MCP registration or
# credential: those are per-run, per-lane policy the worker copies in before
# the container starts (ADR-013 "run HOME" and "review-lane fence"). The hooks
# gstack and GSD registered in settings.json are kept as settings.batteries.json
# for the worker to merge per lane, and Claude's .claude.json (a machine and
# user id minted at build, identical in every container) is dropped.
RUN node /opt/automata/gsd/node_modules/@opengsd/gsd-core/bin/install.js \
      --claude --global --config-dir "$HOME/.claude" --portable-hooks --no-legacy-cleanup; \
    rm -rf "$HOME/.claude/.gsd-source" "$HOME/.claude/.gsd-staging"; \
    mv "$HOME/.claude/settings.json" "$HOME/.claude/settings.batteries.json"; \
    rm -f "$HOME/.claude.json"

# The vendor runtime skills, linked into the agent's Claude config as
# catalog.json lists them (a name the Somnio catalog or GSD already installed
# wins: first come, first linked). Then ruflo's planner and refinement
# agents, sha256-checked, with their frontmatter `hooks` dropped (upstream
# shells out to unpinned `npx claude-flow@alpha` there).
# shellcheck disable=SC2016 # jq programs, not shell expansions
RUN c="${VENDOR_SKILLS_ROOT}/catalog.json"; \
    for v in $(jq -r '.vendors | keys[]' "$c"); do \
      r="${VENDOR_SKILLS_ROOT}/$(jq -r --arg v "$v" '.vendors[$v].root' "$c")"; \
      for k in skills agents commands; do \
        mkdir -p "$HOME/.claude/$k"; \
        for n in $(jq -r --arg v "$v" --arg k "$k" '.vendors[$v][$k][]' "$c"); do \
          e="$r/$k/$n"; [ "$k" = skills ] || e="$e.md"; \
          t="$HOME/.claude/$k/${e##*/}"; \
          if [ -e "$t" ] || [ -L "$t" ]; then continue; fi; \
          test -e "$e"; ln -s "$e" "$t"; \
        done; \
      done; \
    done; \
    a=/opt/automata/ruflo/node_modules/@claude-flow/cli/.claude/agents; \
    echo "${RUFLO_PLANNER_SHA256}  $a/core/planner.md" | sha256sum -c --quiet -; \
    echo "${RUFLO_REFINEMENT_SHA256}  $a/sparc/refinement.md" | sha256sum -c --quiet -; \
    for f in core/planner sparc/refinement; do \
      awk '{ line = $0; sub(/\r$/, "", line) } \
        NR == 1 { if (line != "---") exit 3; fm = 1; print; next } \
        fm && line ~ /^---[ \t]*$/ { fm = 0; skip = 0; print; next } \
        fm && line ~ /^["\047]?[A-Za-z0-9_-]+["\047]?[ \t]*:/ { skip = (line ~ /^["\047]?hooks["\047]?[ \t]*:/) } \
        fm && skip { next } { print } END { if (NR == 0 || fm) exit 4 }' \
        "$a/$f.md" >"$HOME/.claude/agents/${f#*/}.md"; \
      ! grep -q '^hooks:' "$HOME/.claude/agents/${f#*/}.md"; \
    done

# The pins verify.sh checks the installed tools against, so a bump is one edit
# to the ARG lines above, not a second one to verify.sh.
USER root
RUN printf '%s\n' \
      "NODE_VERSION=${NODE_VERSION}" "PNPM_VERSION=${PNPM_VERSION}" \
      "CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}" "GH_VERSION=${GH_VERSION}" \
      "RUFLO_VERSION=${RUFLO_VERSION}" "CHROMIUM_REVISION=${CHROMIUM_REVISION}" \
      "CHROMIUM_VERSION=${CHROMIUM_VERSION}" "BUN_VERSION=${BUN_VERSION}" \
      "FLUTTER_VERSION=${FLUTTER_VERSION}" "SOMNIO_VERSION_LINE='${SOMNIO_VERSION_LINE}'" \
      "ACTIONLINT_VERSION=${ACTIONLINT_VERSION}" "GITLEAKS_VERSION=${GITLEAKS_VERSION}" \
      "SHELLCHECK_VERSION=${SHELLCHECK_VERSION}" >/opt/automata/pins.env; \
    chmod 0444 /opt/automata/pins.env
USER ${AGENT_USER}
WORKDIR /workspace

LABEL org.opencontainers.image.title="automata-batteries" \
      org.opencontainers.image.description="Pinned agent-run image for the execution box (ADR-013)" \
      org.opencontainers.image.source="https://github.com/be-automata/automata" \
      org.opencontainers.image.licenses="Apache-2.0"

CMD ["bash"]
