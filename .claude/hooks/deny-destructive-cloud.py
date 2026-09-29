#!/usr/bin/env python3
"""PreToolUse(Bash) guard: refuse irreversible Hetzner Cloud deletions.

WHY A HOOK AND NOT ONLY A DENY PATTERN. `permissions.deny` matches the command
string by prefix, so `Bash(hcloud server delete *)` catches the obvious form and
misses every equivalent one:

    hcloud --context automata server delete automata-exec-1
    hcloud  server  delete automata-exec-1
    hcloud server delete --help; hcloud server delete X

A deny pattern that a reordered global flag walks straight through is worse than
no guard, because it reads like protection. This hook tokenises the command
instead, so argument order and whitespace do not matter, and it inspects every
segment of a compound command rather than only the first.

SCOPE. `hcloud server delete` is the command the operator asked to fence: it
destroys the execution box and everything on it, and Hetzner does not ask for
confirmation. The adjacent destroyers of persistent state are fenced too, since
the same argument applies to each and leaving them open would make the guard a
formality. Read-only and create/attach verbs are deliberately untouched.

CONTRACT. Exit 2 with a reason on stderr blocks the call and shows the reason.
Exit 0 allows. Anything this script cannot parse it ALLOWS — a guard that fails
closed on its own bugs would wedge every Bash call in the session, and the
permission layer is still underneath. It only ever needs to be right about the
shapes it does recognise.
"""

import json
import re
import shlex
import sys

# (subcommand path, verb) pairs that destroy persistent state.
DENIED = {
    ("server", "delete"),
    ("volume", "delete"),
    ("firewall", "delete"),
    ("ssh-key", "delete"),
    ("network", "delete"),
    ("image", "delete"),
    ("floating-ip", "delete"),
    ("primary-ip", "delete"),
    ("load-balancer", "delete"),
    ("placement-group", "delete"),
}

# Splits a compound command into its segments. Deliberately coarse: it is only
# used to find candidate `hcloud` invocations, never to interpret shell syntax.
SEGMENT_SPLIT = re.compile(r"(?:\|\||&&|\||;|\n)")


def denied_pair(tokens):
    """Return the (noun, verb) this hcloud invocation would run, or None.

    Skips global flags and their values so `hcloud --context x server delete`
    reads the same as `hcloud server delete`.
    """
    if not tokens:
        return None
    # argv[0] may be a path: /opt/homebrew/bin/hcloud
    if tokens[0].rsplit("/", 1)[-1] != "hcloud":
        return None

    words = []
    skip_next = False
    for tok in tokens[1:]:
        if skip_next:
            skip_next = False
            continue
        if tok.startswith("-"):
            # `--context automata` consumes its value; `--context=automata`
            # does not. Anything else is a bare flag.
            if "=" not in tok and tok in ("--context", "--config", "-c"):
                skip_next = True
            continue
        words.append(tok)

    for i in range(len(words) - 1):
        if (words[i], words[i + 1]) in DENIED:
            return (words[i], words[i + 1])
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    if payload.get("tool_name") != "Bash":
        return 0
    command = (payload.get("tool_input") or {}).get("command")
    if not isinstance(command, str):
        return 0

    for segment in SEGMENT_SPLIT.split(command):
        segment = segment.strip()
        if not segment:
            continue
        try:
            tokens = shlex.split(segment)
        except ValueError:
            # Unbalanced quotes — not something to guess at.
            continue
        hit = denied_pair(tokens)
        if hit:
            noun, verb = hit
            sys.stderr.write(
                f"Blocked by .claude/hooks/deny-destructive-cloud.py: "
                f"`hcloud {noun} {verb}` destroys persistent infrastructure and "
                f"Hetzner does not ask for confirmation.\n"
                f"This guard exists because the operator asked for it. If the "
                f"deletion is genuinely intended, run it yourself outside this "
                f"session.\n"
            )
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
