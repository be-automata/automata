# The `automata-hatchet` tunnel: who serves it, and how to move it back

`hatchet.beautomata.com` is how the Cloudflare Worker control plane reaches the
execution plane's engine. The Worker cannot speak gRPC and the engine's ports are
loopback-only (#192), so this named tunnel is the *only* path in.

**Since the Phase 1 cutover it is served by the shared Linux box**, not the
operator's laptop.

| | |
|:--|:--|
| Tunnel | `automata-hatchet`, id `73d79054-70f6-40f8-901a-d445eff83577` |
| Hostname | `hatchet.beautomata.com` → `http://127.0.0.1:8888` on whichever host runs the connector |
| On the box | `cloudflared-automata-hatchet.service`, config `/etc/cloudflared/config.yml`, credential `/etc/cloudflared/<tunnel-id>.json` (0600) |
| On the laptop (now unloaded) | launchd agent `com.automata.hatchet-tunnel`, config `~/.cloudflared/automata-hatchet.yml` |

## ⚠ Exactly one connector at a time

Cloudflare **load-balances across every connector registered for a tunnel**. Two
connectors therefore do not mean redundancy here — they mean requests are split
between two DIFFERENT engines holding different state, so a run dispatched through
one is invisible to the other. That is worse than either host alone.

So the laptop's agent must stay unloaded while the box serves:

```bash
launchctl list | grep com.automata.hatchet-tunnel     # must print nothing
```

It has `KeepAlive`, so killing the process is not enough — it respawns with a new
pid. Use `launchctl bootout gui/$UID/com.automata.hatchet-tunnel`.

## The token is NOT portable between engines

Tenant ids are seeded deterministically by hatchet-lite, so `HATCHET_TENANT_ID`
(`707d0855-80ab-4e1f-a156-f1c4546cbf52`) is the same on both hosts and needs no
change. The API token is a JWT signed with the engine's own keyset, which lives in
that engine's `/config` volume — so **moving the connector requires minting a new
token on the destination engine and rotating the Worker secret**:

```bash
# on the destination host
docker exec automata-hatchet-hatchet-lite-1 \
  /hatchet-admin --config /config token create \
  --name automata-www --tenant-id 707d0855-80ab-4e1f-a156-f1c4546cbf52
# `--config /config` is required; without it the CLI dies on
# "at least one cookie secret must be provided"

# then, from apps/www
npx wrangler secret put HATCHET_API_TOKEN     # paste the token
```

Worker secrets take effect on the next invocation; no redeploy is needed.
`HATCHET_API_URL` is unchanged because the hostname does not move.

## Verifying a cutover

The endpoint returning 200 is not by itself proof that the *intended* host is
serving it — check that the other host's engine is NOT answering locally, or the
200 could be coming from either:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://hatchet.beautomata.com/api/ready   # 200
ssh <box> 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8888/api/ready' # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8888/api/ready             # on the laptop
```

Then confirm work actually lands:

```bash
ssh <box> 'docker exec automata-hatchet-postgres-1 \
  psql -U hatchet -d hatchet -t -A -c "select count(*) from v1_tasks_olap;"'
ssh <box> 'journalctl -u automata-worker.service | grep -c "Task run starting"'
```

## Failing back to the laptop

Both halves, in this order, or traffic splits:

```bash
ssh <box> 'systemctl disable --now cloudflared-automata-hatchet.service'
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.automata.hatchet-tunnel.plist
# then mint a token on the LAPTOP's engine and rotate HATCHET_API_TOKEN back
```

The laptop's engine must be running first — its compose stack had exited when the
cutover was made, which is what made the endpoint 502 and the cutover urgent
rather than merely planned.

## What the cutover does NOT change

The laptop's worker (`com.automata.worker`) is a separate unit from the tunnel. It
was already stopped at cutover time. Leaving it stopped is correct: two workers on
one tenant both take work, and the box is the one being proven.
