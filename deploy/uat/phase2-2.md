# Phase 2 ticket 2 (#205) — counting box slots: production UAT

Box: `automata-exec-1` (Hetzner CX33, Ubuntu 24.04). Worker commit: _(filled at deploy)_.

The epic's AC 3/4 speak of "transient scopes"; the shipped mechanism (#204) is a
delegated cgroup per run under `/sys/fs/cgroup/system.slice/automata-worker.service/`,
so the evidence below records run cgroups (`run-<threadId>-<digest>`) instead.

## Rollout

Deployed at **N = 1** (`WORKER_BOX_SLOTS` unset): byte-identical lock, kill and layout.
N = 2 is proven as a bounded drill below and the box returns to N = 1 afterwards, until
#371 (headroom check) and #372 (sizing from the sampler) are live.

## Drill — N = 2 (#205 UAT 1–4; epic gate before ticket 3)

Preconditions: slot account `automata-agent-1` (uid 2001), sudoers Runas list, nft set
`{ 999, 2001 }` loaded via `nft-preflight.sh` (marker `/run/automata/egress-fence.uids`
present), `/proc` remounted `hidepid=invisible,gid=<worker gid>` (§6; `ps` as slot 1 lists
only slot 1), traverse ACL on the workdir root, `WORKER_BOX_SLOTS=2`, no run in flight before
the restart.

| #   | Check                                                                                                                                                                                             | Evidence  |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :-------- |
| 1   | Boot: `box slots: 2 (automata-agent, automata-agent-1)`; `max_units` 2 on the Worker row                                                                                                          | _pending_ |
| 2   | Two runs on different variants/orgs execute concurrently, each in its own run cgroup under its own uid; `lsof` shows holders on `box.lock` and `box.lock.1`                                       | _pending_ |
| 3   | Teardown of one leaves the sibling's processes alive; its verdict posts; no cross-slot kill in the journal                                                                                        | _pending_ |
| 4   | A third run while both slots are held waits (engine QUEUED / worker `box budget full`), is not FAILED or CANCELLED, and runs when a slot frees                                                    | _pending_ |
| 5   | Cross-slot fences hold: from slot 1's account, `connect` to slot 0's daemon socket and gh socket is refused (EACCES), and a request to slot 0's egress proxy port without its credential gets 407 | _pending_ |
| 6   | Back to N = 1: boot log and lock lines byte-compatible with the pre-change box                                                                                                                    | _pending_ |
