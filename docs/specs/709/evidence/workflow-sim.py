"""Exercise the synthetic.yml `cell-evidence` job's steps with a fake gh and curl.

Each scenario runs the job's steps in order (honouring each step's `if:` on
steps.read.outputs.status) against a fake issue store, then prints the calls.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

wf_path = sys.argv[1]
import yaml

job = yaml.safe_load(open(wf_path))["jobs"]["cell-evidence"]
steps = job["steps"]

work = tempfile.mkdtemp()
bindir = os.path.join(work, "bin")
os.makedirs(bindir)
store = os.path.join(work, "issues.json")
calls = os.path.join(work, "calls.log")

open(os.path.join(bindir, "curl"), "w").write(
    "#!/bin/bash\ncat \"$FAKE_STATUS\"\n"
)
# gh: issue list/create/comment/close and label create, against a JSON file.
open(os.path.join(bindir, "gh"), "w").write(r'''#!/usr/bin/env python3
import json, os, sys
store = os.environ["FAKE_STORE"]; calls = os.environ["FAKE_CALLS"]
issues = json.load(open(store)) if os.path.exists(store) else []
args = sys.argv[1:]
open(calls, "a").write(" ".join(a if " " not in a else repr(a) for a in args[:3]) + "\n")
if args[:2] == ["issue", "list"]:
    label = args[args.index("--label") + 1]
    open_ = [i for i in issues if i["label"] == label and i["state"] == "open"]
    print(open_[0]["number"] if open_ else "")
elif args[:2] == ["issue", "create"]:
    label = args[args.index("--label") + 1]
    body = open(args[args.index("--body-file") + 1]).read()
    n = 100 + len(issues)
    issues.append({"number": n, "label": label, "state": "open", "body": body})
    print(f"https://github.invalid/issues/{n}")
elif args[:2] == ["issue", "close"]:
    for i in issues:
        if i["number"] == int(args[2]): i["state"] = "closed"
json.dump(issues, open(store, "w"))
''')
for f in ("curl", "gh"):
    os.chmod(os.path.join(bindir, f), 0o755)


def run_job(status):
    status_file = os.path.join(work, "fake-status.json")
    json.dump(status, open(status_file, "w"))
    out_file = os.path.join(work, "gh_output")
    open(out_file, "w").close()
    env = dict(os.environ)
    env.update(
        PATH=bindir + ":" + env["PATH"],
        FAKE_STATUS=status_file,
        FAKE_STORE=store,
        FAKE_CALLS=calls,
        SMOKE_BASE_URL="https://www.example.test",
        RUN_URL="https://github.invalid/run/1",
        GITHUB_OUTPUT=out_file,
    )
    outputs = {}
    for step in steps:
        cond = step.get("if")
        if cond:
            s = outputs.get("status", "")
            expr = re.sub(r"steps\.read\.outputs\.status", repr(s), cond)
            expr = expr.replace("||", " or ").replace("&&", " and ")
            if not eval(expr):
                continue
        r = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", step["run"]],
                           cwd=work, env=env, capture_output=True, text=True)
        if r.returncode != 0:
            return f"step '{step['name']}' failed: {r.stderr.strip()[:200]}"
        for line in open(out_file):
            k, _, v = line.strip().partition("=")
            outputs[k] = v
    return "ok"


def state():
    issues = json.load(open(store)) if os.path.exists(store) else []
    return [(i["number"], i["state"]) for i in issues]


scenarios = [
    ("fresh evidence", {"status": "ok", "expiresAt": "2027-01-10T00:00:00.000Z", "daysLeft": 20}),
    ("expiring (3 days)", {"status": "expiring", "expiresAt": "2026-12-19T00:00:00.000Z", "daysLeft": 3}),
    ("expiring again, issue already open", {"status": "expiring", "expiresAt": "2026-12-19T00:00:00.000Z", "daysLeft": 2}),
    ("expired (refused) while open", {"status": "refused", "reason": "evidence_expired", "expiresAt": "2026-12-19T00:00:00.000Z"}),
    ("renewed -> ok", {"status": "ok", "expiresAt": "2027-01-18T00:00:00.000Z", "daysLeft": 30}),
    ("cells unconfigured", {"status": "unconfigured"}),
    ("refused, no evidence", {"status": "refused", "reason": "evidence_missing", "expiresAt": None}),
    ("bad body", {"nope": 1}),
]
for name, status in scenarios:
    open(calls, "w").close()
    result = run_job(status)
    print(f"=== {name}: job={result}")
    print("  gh calls: " + "; ".join(l.strip() for l in open(calls)) )
    print(f"  issues: {state()}")
issues = json.load(open(store))
print("=== first issue body:\n" + issues[0]["body"])
print("=== second issue body:\n" + issues[1]["body"])
