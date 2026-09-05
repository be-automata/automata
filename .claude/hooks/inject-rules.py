#!/usr/bin/env python3
"""PreToolUse(Write) hook: inject path-scoped rules when creating a new file.

Works around the read-not-create caveat (#23478): `.claude/rules/*.md` files
with `paths:` frontmatter load on read, not on create. When Claude creates a
NEW file matching a rule's paths, this injects that rule's body as
additionalContext so it is in context before the file is written.

Fires only for: Write to a file that does NOT yet exist AND matches at least
one rule's `paths:` patterns. Otherwise it exits silently.
"""
import json
import sys
import os
import re
import glob

MAX_CONTEXT_BYTES = 64 * 1024  # upper bound on injected rule text per Write


def glob_to_regex(pat):
    out, i = ['^'], 0
    while i < len(pat):
        if pat[i:i + 3] == '**/':
            out.append('(?:.*/)?')
            i += 3
        elif pat[i:i + 2] == '**':
            out.append('.*')
            i += 2
        elif pat[i] == '*':
            out.append('[^/]*')
            i += 1
        elif pat[i] == '?':
            out.append('[^/]')
            i += 1
        else:
            out.append(re.escape(pat[i]))
            i += 1
    out.append('$')
    return re.compile(''.join(out))


def parse_paths(frontmatter):
    paths, in_paths = [], False
    for line in frontmatter.splitlines():
        if re.match(r'^paths:\s*$', line):
            in_paths = True
            continue
        if in_paths:
            m = re.match(r'^\s*-\s*(.+?)\s*$', line)
            if m:
                paths.append(m.group(1).strip('"\''))  # YAML-quoted globs (a bare * is a YAML alias)
            elif line.strip() and not line[0].isspace():
                in_paths = False
    return paths


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return

    proj = os.environ.get('CLAUDE_PROJECT_DIR') or data.get('cwd') or os.getcwd()
    file_path = (data.get('tool_input') or {}).get('file_path', '')
    if not file_path:
        return

    abs_fp = file_path if os.path.isabs(file_path) else os.path.join(proj, file_path)
    # Only the caveat case: a brand-new file.
    if os.path.exists(abs_fp):
        return

    rel = os.path.relpath(abs_fp, proj)
    if rel.startswith('..'):
        return  # outside the project: never match repo rules against foreign paths
    # The path is echoed into model context: strip control chars and backticks so a
    # crafted filename cannot break out of the formatting below.
    safe_rel = re.sub(r'[\x00-\x1f`]', '', rel)
    chunks = []
    pattern = os.path.join(proj, '.claude', 'rules', '**', '*.md')
    for rule_file in glob.glob(pattern, recursive=True):
        try:
            txt = open(rule_file, encoding='utf-8').read()
        except Exception:
            continue
        if not txt.startswith('---'):
            continue
        end = txt.find('\n---', 3)
        if end == -1:
            continue
        frontmatter, body = txt[3:end], txt[end + 4:]
        if any(glob_to_regex(p).match(rel) for p in parse_paths(frontmatter)):
            chunks.append(body.strip())
            if sum(len(c) for c in chunks) > MAX_CONTEXT_BYTES:
                break  # keep the injection bounded; a runaway rule set must not stall every Write

    if not chunks:
        return

    context = (
        'The file you are about to create (`' + safe_rel + '`) matches path-scoped '
        'rules that were NOT yet loaded into context (they load on read, not on '
        'create). Apply the following rule(s) to the content you write now:\n\n'
        + '\n\n---\n\n'.join(chunks)
    )
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'additionalContext': context,
        }
    }))


main()
