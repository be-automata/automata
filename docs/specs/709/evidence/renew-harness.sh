#!/bin/bash
# Runs opensandbox-evidence-renew.sh as root in a throwaway Linux container against
# stubs: a fake OpenSandbox list endpoint, a fake host docker, a fake pnpm (the IT)
# and a fake push-evidence.sh. No real secret, no network beyond apt.
set -uo pipefail
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq jq util-linux >/dev/null 2>&1 || { echo "apt failed"; exit 1; }
SCRIPT=/src/opensandbox-evidence-renew.sh
FAKE_SECRET="s3cr3t-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
mkdir -p /etc/automata /stub/bin
printf 'AUTOMATA_WWW_URL=https://www.example.test\nPROFILE_EVIDENCE_SECRET=%s\n' "$FAKE_SECRET" > /etc/automata/profile-evidence.env
printf 'OPENSANDBOX_API_KEY=%064d\n' 0 > /etc/automata/opensandbox.env
chmod 600 /etc/automata/*.env

# fake checkout, owned by another user, committed and clean
useradd -m automata
P=/opt/automata-platform
mkdir -p $P/packages/sandbox/opensandbox-it
cat > $P/packages/sandbox/opensandbox-it/push-evidence.sh <<'EOF'
#!/bin/bash
# stub: proves it got the secret by env and the evidence file exists
[ -n "${PROFILE_EVIDENCE_SECRET:-}" ] || { echo '{"error":"Unauthorized"}'; exit 22; }
[ -f "$OPENSANDBOX_IT_STATE/opensandbox-runc-conformance.json" ] || exit 1
if [ -n "${PUSH_REFUSE:-}" ]; then echo '{"recorded":false,"reason":"check_failed"}'; exit 22; fi
echo '{"recorded":true,"rows":9,"expiresAt":"2026-12-26T04:10:00.000Z"}'
EOF
cat > $P/packages/sandbox/opensandbox-it/down.sh <<'EOF'
#!/bin/bash
echo "down: stub"
EOF
chmod +x $P/packages/sandbox/opensandbox-it/*.sh
echo node_modules > $P/.gitignore; git -C $P init -q && git -C $P add -A && git -C $P -c user.email=t@t -c user.name=t commit -qm init
chown -R automata:automata $P

cat > /stub/bin/docker <<'EOF'
#!/bin/bash
case "$1" in
  info) echo /var ;;
  ps) [ -n "${OSBIT_UP:-}" ] && echo abc123 ; exit 0 ;;
esac
EOF
cat > /stub/bin/pnpm <<'EOF'
#!/bin/bash
# stub IT: fail if the secret leaked into its environment; write evidence
env | grep -q PROFILE_EVIDENCE_SECRET && { echo "LEAK: secret in IT env"; exit 3; }
echo "IT output that must not reach the journal: canary-it-output"
mkdir -p "$OPENSANDBOX_IT_STATE"
echo '{"measuredAt":"x"}' > "$OPENSANDBOX_IT_STATE/opensandbox-runc-conformance.json"
mkdir -p /opt/automata-platform/packages/sandbox/node_modules/.vite-temp && touch /opt/automata-platform/packages/sandbox/node_modules/.vite-temp/root-owned-cache
exit "${IT_RC:-0}"
EOF
chmod +x /stub/bin/*
export PATH=/stub/bin:$PATH

serve() { # $1 = JSON body for GET /sandboxes
  pkill -f stubserver >/dev/null 2>&1; sleep 0.3
  BODY="$1" python3 - stubserver <<'PY' &
import http.server, os, sys
body = os.environ["BODY"].encode()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.headers.get("OPEN-SANDBOX-API-KEY") == "0" * 64 and "metadata=automata%3Dcell" in self.path
        self.send_response(200 if ok else 401); self.end_headers()
        self.wfile.write(body if ok else b"{}")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 8090), H).serve_forever()
PY
  sleep 0.7
}

run() { # name, then env assignments
  local name="$1"; shift
  echo "=== $name"
  out=$(env "$@" STATE_DIRECTORY=/var/lib/automata-cell-evidence bash "$SCRIPT" ${DRY:+--dry-run} 2>&1); rc=$?
  echo "$out"
  echo "exit=$rc"
  if printf '%s' "$out" | grep -q "$FAKE_SECRET"; then echo "SECRET LEAKED"; fi
  if printf '%s' "$out" | grep -q "canary-it-output"; then echo "IT OUTPUT LEAKED"; fi
}

serve '{"items":[{"id":"c1","metadata":{"automata":"cell","worker":"w1"}}],"pagination":{"hasNextPage":false}}'
run "AC3: a live cell -> skip"
serve '{"items":[],"pagination":{"hasNextPage":false}}'
DRY=1 run "dry run on an idle box -> plan only"
run "hand-run IT up -> skip" OSBIT_UP=1
serve '{"items":"nope"}'
run "malformed page -> fail closed"
serve '{"items":[],"pagination":{"hasNextPage":true}}'
run "empty page but more pages -> fail closed"
serve '{"items":[],"pagination":{"hasNextPage":false}}'
run "idle -> IT + push, renewed"
echo "root-owned left under packages/sandbox: $(find $P/packages/sandbox -user 0 | wc -l)"
echo "git index owner: $(stat -c %U $P/.git/index)"
run "push refused -> fail with the enum only" PUSH_REFUSE=1
run "IT fails -> fail" IT_RC=1
echo "last-it.log mode: $(stat -c %a /var/lib/automata-cell-evidence/last-it.log)"
touch $P/dirty-file
run "dirty checkout -> fail"
rm -f $P/dirty-file
( flock -n 9 && sleep 3 ) 9>/run/automata-cell-evidence.lock &
sleep 0.5
run "another run holds the lock -> skip"
sleep 3; pkill -f stubserver || true
