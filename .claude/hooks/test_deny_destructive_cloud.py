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



def check_declarative_mirror():
    """The deny patterns in settings.json must mirror the hook's DENIED set.

    The hook's own docstring justifies those entries as making the guard
    "visible when reading the config, not only when running it". A list that
    covers fewer verbs than the hook does not do that — it undersells the fence
    to anyone scanning settings.json. It drifted the first time it was written
    (10 pairs in the hook, 6 in the config), which is why this is a test and not
    a convention.
    """
    import re

    settings = json.loads((HOOK.parent.parent / "settings.json").read_text())
    declared = set()
    for entry in settings.get("permissions", {}).get("deny", []):
        m = re.fullmatch(r"Bash\(hcloud (\S+) (\S+) \*\)", entry)
        if m:
            declared.add((m.group(1), m.group(2)))

    source = HOOK.read_text()
    body = source.split("DENIED = {", 1)[1].split("}", 1)[0]
    in_hook = set(re.findall(r'\("([^"]+)",\s*"([^"]+)"\)', body))

    problems = []
    for pair in sorted(in_hook - declared):
        problems.append(f"  hook blocks {pair} but settings.json does not list it")
    for pair in sorted(declared - in_hook):
        problems.append(f"  settings.json lists {pair} but the hook does not block it")
    return problems


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

    failures.extend(check_declarative_mirror())

    if failures:
        print(f"FAIL ({len(failures)})")
        print("\n".join(failures))
        return 1
    print(f"ok — {len(CASES) + 3} cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
