# Agent-uid provisioning (#108)

Run the agent child under a dedicated unprivileged unix account so the #66 PF
anchor can be applied with real teeth without fencing the operator.

Everything here is **manual host configuration performed by the operator**. No
code in this repo executes any of it, and none of it is CI-verified. The code
side is default-OFF: with `WORKER_AGENT_USER` empty the worker behaves exactly
as it did before this ticket — no sudo, no ACLs, no observe-mode proxy.

**Order:** the daemon bundle carrying the proxy-aware callback
(`packages/daemon/src/proxy-fetch.ts`) must be **live on the box** before the PF
anchor is loaded. Load the anchor first and the daemon's own
`POST /api/daemon-event` is dropped at the packet level, silently, and every run
produces no output.

---

## What this actually buys, and what it does not

Buys:

- The agent's uid ≠ the operator's, so the operator's login Keychain, `~/.ssh`
  and `~/.config/gh` are unreachable by DAC, and PF can fence the agent alone.
- Nothing flows agent uid → operator uid.

Does **not** buy:

- **Per-run isolation.** All runs share one agent uid. Cross-run reads are
  prevented only by where the ACEs are placed (the per-run workdir, and this
  worker's own `runs/<workerId>/` rendezvous dir — never the shared root),
  never by ownership.
- **Protection from a forged process group.** The worker group-kills the pgid
  the sudo wrapper wrote into `runs/<workerId>/<threadId>.pid`, a file the
  agent uid can write. A prompt-injected agent could put another run's pgid
  there and have the worker kill it. This grants the attacker NOTHING new: all
  runs share one uid, so that agent can already signal any sibling agent
  process directly with `kill(2)`. It is the same fact as the bullet above —
  one uid is not a per-run boundary — and authenticating the pidfile would not
  change it.
- **A command fence.** See the header of `sudoers.d-automata`. The sudoers rule
  is a uid-drop capability; the grantee already outranks the runas account.
- **Closure of the daemon's bearer surface.** The agent already receives
  `DAEMON_TOKEN`, so the control-plane callback is a bearer API exposed to the
  agent. Pre-existing, out of scope here, named so it is not forgotten.
- **A complete egress control.** See "PF honesty" below.

---

## 1. The role account

```bash
sudo sysadminctl -addUser _automata-agent \
     -fullName "Automata Agent" -UID 300 -GID 300 \
     -shell /usr/bin/false -home /var/empty -roleAccount
id -u _automata-agent            # MUST print 300 (200-400 is the role range)
dscl . -read /Groups/_automata-agent >/dev/null
```

It must have no sudoers entry of its own, and it must never be uid 501.

## 2. A runtime tree the agent uid can read

```bash
sudo mkdir -p /usr/local/automata/bin /usr/local/automata/daemon /usr/local/automata/runs
sudo cp "$(readlink -f "$(command -v node)")" /usr/local/automata/bin/node
sudo cp -R "$(dirname "$(readlink -f "$(command -v claude)")")"/. /usr/local/automata/bin/
sudo chown -R root:wheel /usr/local/automata/bin /usr/local/automata/daemon
sudo chmod -R a+rX /usr/local/automata /usr/local/automata/bin /usr/local/automata/daemon
# runs/ belongs to the WORKER. At BOOT the worker opens its own
# runs/<workerId>/ dir to the agent uid with an inheritable ACE (before any
# socket is bound — macOS applies inheritance at create time); the root itself
# gets traverse only, so one WORKER cannot read another's.
sudo chown "$(id -un)":staff /usr/local/automata/runs && sudo chmod 700 /usr/local/automata/runs
sudo -u _automata-agent /usr/local/automata/bin/node --version
```

The node at `/usr/local/automata/bin/node` must be **≥22.21.0 (22.x) or
≥24.0.0**. The worker probes it at boot and refuses to start below that floor:
`NODE_USE_ENV_PROXY` does not exist on node 20, and a box below the floor turns
every fenced run into a 90-second stall with no output rather than an error.

`/usr/local/automata/daemon/index.js` must be the freshly built bundle. Prefer
`chown $(id -un)` on that one directory so `run-worker.sh` can copy the build in
without another sudo grant.

## 3. sudoers

See `sudoers.d-automata` — install instructions and the full security rationale
are in its header. Validate on a copy with `visudo -cf` **before** installing:
a syntax error in any `sudoers.d` file breaks `sudo` box-wide.

## 4. The PF anchor

**Do not edit `/etc/pf.conf`.** It is not SIP-protected, but Apple rewrites it
during OS updates and your edit disappears with the anchor. Ship the wrapper
instead.

```bash
sudo cp ../../../deploy/egress-pf.conf /etc/pf.anchors/automata-egress
sudo sed -i '' "s/__AGENT_UID__/$(id -u _automata-agent)/" /etc/pf.anchors/automata-egress
sudo install -o root -g wheel -m 0644 automata-pf.conf /etc/automata-pf.conf
sudo ./pf-preflight.sh _automata-agent     # validates the rendered uid, parses, then loads with -E
sudo ./pf-verify.sh
```

`pf-preflight.sh` refuses to load unless every rendered `user <uid>` equals
`id -u _automata-agent` and is not 501, and it runs `pfctl -n -f` before
`pfctl -E -f`. **`-E`, never `-e`:** Apple's own `/etc/pf.conf` header documents
the enable refcount — with `-e`, any macOS component calling `pfctl -X <token>`
drops it to zero and silently disables PF and this anchor.

Survive reboot (one-shot `pfctl` loads do not):

```bash
sudo install -o root -g wheel -m 0644 com.automata.pf.plist \
  /Library/LaunchDaemons/com.automata.pf.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.automata.pf.plist
```

Re-run `pf-verify.sh` after every reboot and every OS update. Never assume the
boot path stayed wired.

## 5. Worker env

```bash
cat >> ~/.automata/worker-box.env <<'EOF'
WORKER_AGENT_USER=_automata-agent
WORKER_WORKDIR_ROOT=/usr/local/automata/runs
WORKER_DAEMON_DIST=/usr/local/automata/daemon/index.js
WORKER_NODE_BIN=/usr/local/automata/bin/node
CLAUDE_BIN=/usr/local/automata/bin
EOF
```

`WORKER_AGENT_USER` without `WORKER_WORKDIR_ROOT` is a hard boot failure: the
default root is `os.tmpdir()`, which on macOS is a 0700 directory owned by the
worker's own uid and untraversable by any other, so every run would die at clone.

---

## Verification gates

**G1 — units green, cross-platform.**

```
pnpm -C packages/worker tsc-check && pnpm -C packages/worker test
pnpm -C packages/daemon tsc-check && pnpm -C packages/daemon test
```

No test invokes `sudo`, `dscl`, `sysadminctl`, `pfctl` or the network; the only
darwin-specific case (real ACE inheritance) is `skipIf`-guarded.

**G2 — sudoers wired and `-E` accepted.**

```bash
sudo -n -u _automata-agent -E -- /usr/local/automata/bin/node -e 'process.exit(0)'; echo $?
```

Must print `0`. "not allowed to preserve the environment" means `SETENV` is
missing from the rule.

**G3 — the process-group shape.**

```bash
PIDFILE=$(mktemp)
sudo -n -u _automata-agent -E AUTOMATA_PIDFILE=$PIDFILE AUTOMATA_NODE=/usr/local/automata/bin/node -- \
  /bin/sh -c 'printf %s "$$" > "$AUTOMATA_PIDFILE"; exec "$AUTOMATA_NODE" "$@"' \
  automata-daemon -e 'setTimeout(()=>{},60000)' &
sleep 1; PGID=$(cat $PIDFILE)
pgrep -u _automata-agent -f setTimeout | xargs ps -o pid,ppid,pgid,sess,uid,comm -p
```

PASS = the node process's `pgid` equals `$PGID`. Then
`sudo -n -u _automata-agent -- /bin/kill -9 -- -$PGID` and confirm
`pgrep -u _automata-agent` is empty.

**G4 — the anchor has teeth.** `sudo -u _automata-agent curl -m 5
https://example.com` must fail (exit 28). This mirrors Anthropic's own
devcontainer `init-firewall.sh` self-test.

**G5 — the operator is NOT fenced.** `curl -m 5 -o /dev/null -w '%{http_code}'
https://example.com` as the worker's login must print `200`. A failure here means
`__AGENT_UID__` was substituted with the wrong uid — roll back immediately.

**G6 — rules loaded.** `sudo ./pf-verify.sh`, and again after a reboot.

**G7 — a real review run** end to end under `WORKER_AGENT_USER`, reaching a
parsed verdict. Watch for four named signatures: a 15s "daemon socket not
ready" (an ACE did not land), "not allowed to preserve the environment"
(`SETENV` missing), a `gh` that cannot reach its broker socket (the boot ACE
did not run — it must precede every bind), and zero daemon events with a live
daemon (the proxy-aware daemon bundle is not the one deployed).

---

## PF honesty — required reading before this is cited as a control

- **Apple TN3165 (2024-02-27), "Packet Filter is not API":** "It is not
  considered API. Do not use Packet Filter in a software product that you
  distribute to a wide audience." PF rules "might clash with those installed by:
  The user; macOS system services, either now or in the future; Other
  third-party products."
- **macOS 15.0–15.3.1 had system processes bypassing `block all`**
  (`com.apple.geod`, `com.apple.WebKit`; Apple DevForums 776914). Not observed on
  14.7.4, and the pilot box is 15.7.3, past that range — but a PF-based egress
  claim cannot be asserted COMPLETE on macOS 15+.
- **Forwarded (VM/OrbStack/Docker) traffic is not covered.** `pf.conf(5)`: "For
  forwarded connections, where the firewall is not a connection endpoint, the
  user and group are unknown", and "user >= 0 does not match forwarded packets".
  Guest traffic reaching the host on a vmnet interface is neither matched nor
  blocked by a uid rule. Filter VM traffic by subnet and direction, never by uid.
- **`user` rules match the effective uid latched at socket-creation time.** Our
  daemon is spawned as the agent uid from the start, so this is fine.
- **Not closed by this anchor:** DNS tunnelling, ports other than 80/443, unix
  sockets to operator-uid listeners, and the deliberate loopback git/gh brokers
  (which are bearer-protected capability grants and egress as the worker).

PF here is a best-effort backstop for ONE pilot box. NetworkExtension is the
durable mechanism.

## Rollback

```bash
sudo ./pf-verify.sh || true
sudo pfctl -a automata-egress -F rules            # drop the block, keep PF up
sudo launchctl bootout system/com.automata.pf     # stop reloading it at boot
sudo rm /etc/sudoers.d/automata                   # revoke the delegation
# then WORKER_AGENT_USER= in worker-box.env and restart the worker units
```

Order matters. Flush the PF rules **first**: removing `WORKER_AGENT_USER` while
the anchor is loaded is harmless (it fences a uid nothing then runs as), but
removing sudoers first while runs are in flight strands live daemons that
neither `process.kill` nor `sudo kill` can reap.
