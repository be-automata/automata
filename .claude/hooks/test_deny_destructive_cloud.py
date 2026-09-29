#!/usr/bin/env python3
"""Tests for deny-destructive-cloud.py.

Every BLOCK case below is a form a prefix-matching `permissions.deny` pattern
would let through. That is the whole reason the hook exists, so these are the
tests that matter.

Run: python3 .claude/hooks/test_deny_destructive_cloud.py
"""

import json
import subprocess
import sys
from pathlib import Path

HOOK = Path(__file__).with_name("deny-destructive-cloud.py")

BLOCK = 2
ALLOW = 0


def run(command, tool_name="Bash"):
    payload = json.dumps({"tool_name": tool_name, "tool_input": {"command": command}})
    proc = subprocess.run(
        [sys.executable, str(HOOK)],
        input=payload,
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stderr


CASES = [
    # ── the plain form ────────────────────────────────────────────────────
    ("hcloud server delete automata-exec-1", BLOCK),
    # ── the forms a prefix pattern misses ─────────────────────────────────
    ("hcloud --context automata server delete automata-exec-1", BLOCK),
    ("hcloud --context=automata server delete automata-exec-1", BLOCK),
    ("hcloud  server   delete  automata-exec-1", BLOCK),
    ("/opt/homebrew/bin/hcloud server delete automata-exec-1", BLOCK),
    ("hcloud server list && hcloud server delete automata-exec-1", BLOCK),
    ("echo hi; hcloud server delete automata-exec-1", BLOCK),
    ("hcloud server list || hcloud server delete x", BLOCK),
    ("hcloud server delete 167890207 --poll-interval 1s", BLOCK),
    # ── the adjacent destroyers ───────────────────────────────────────────
    ("hcloud firewall delete automata-execution-plane", BLOCK),
    ("hcloud ssh-key delete automata-execution-plane", BLOCK),
    ("hcloud volume delete v1", BLOCK),
    # ── everything that must keep working ─────────────────────────────────
    ("hcloud server list", ALLOW),
    ("hcloud server describe automata-exec-1", ALLOW),
    ("hcloud server create --name x --type cx33 --image ubuntu-24.04", ALLOW),
    ("hcloud server reboot automata-exec-1", ALLOW),
    ("hcloud server metrics automata-exec-1 --type cpu", ALLOW),
    ("hcloud context list", ALLOW),
    ("hcloud firewall describe automata-execution-plane", ALLOW),
    # The word "delete" is not by itself a deletion.
    ("git commit -m 'delete the server stanza'", ALLOW),
    ("grep -r 'hcloud server delete' docs/", ALLOW),
    ("echo 'do not run hcloud server delete'", ALLOW),
    # Deleting a LOCAL file that merely mentions hcloud is not our business.
    ("rm -f /tmp/hcloud-server-delete-notes.txt", ALLOW),
    # Unparseable input must not wedge the session.
    ('hcloud server delete "unbalanced', ALLOW),
]


def main():
    failures = []

    for command, expected in CASES:
        code, err = run(command)
        if code != expected:
            failures.append(
                f"  {command!r}\n    expected {expected}, got {code}"
                + (f" (stderr: {err.strip()[:80]})" if err else "")
            )

    # A blocked call must SAY why — a silent exit 2 is unactionable.
    code, err = run("hcloud server delete automata-exec-1")
    if code == BLOCK and "hcloud server delete" not in err:
        failures.append("  block message does not name the command")

    # Non-Bash tools are none of this hook's business.
    code, _ = run("hcloud server delete x", tool_name="Read")
    if code != ALLOW:
        failures.append("  non-Bash tool was blocked")

    # Malformed stdin must allow, not crash.
    proc = subprocess.run(
        [sys.executable, str(HOOK)], input="not json", capture_output=True, text=True
    )
    if proc.returncode != ALLOW:
        failures.append(f"  malformed stdin returned {proc.returncode}, expected 0")

    if failures:
        print(f"FAIL ({len(failures)})")
        print("\n".join(failures))
        return 1
    print(f"ok — {len(CASES) + 3} cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
