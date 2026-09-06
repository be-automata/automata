#!/usr/bin/env python3
"""PreToolUse(Write) hook: inject path-scoped rules when creating a new file.

Works around the read-not-create caveat (#23478): `.claude/rules/*.md` files
with `paths:` frontmatter load on read, not on create. When Claude creates a
NEW file matching a rule's paths, this injects that rule's body as
additionalContext so it is in context before the file is written.

Fires only for: Write to a file that does NOT yet exist AND matches at least
one rule's `paths:` patterns. Otherwise it exits silently.

Never blocks: any failure (malformed stdin, unreadable rule, bad pattern,
missing interpreter feature) is swallowed and the process exits 0. A non-zero
exit from a PreToolUse hook DENIES the Write, so this is load-bearing.

Matcher parity with the somnio plugin asset (0.9.6): brace expansion, bracket
classes, YAML flow-form `paths: [...]`, quoted globs. The scan itself is
deliberately stricter than upstream and must stay that way — see the guards in
main(): no symlink following, realpath dedupe, out-of-tree paths ignored, the
echoed path sanitised, and a byte cap on the injected text.
"""
import itertools
import json
import sys
import os
import re

MAX_CONTEXT_BYTES = 64 * 1024  # upper bound on injected rule text per Write


def _split_top(text):
    """Split a YAML flow sequence body on its item separators.

    A comma only separates items at the top level. Glob syntax has exactly three
    nesting contexts in which a comma is data rather than a separator, and all
    three are tracked here, so the set is closed:

      - quotes      `"a,b.ts"`          a quoted item
      - `{...}`     `src/**/*.{ts,tsx}` a brace group
      - `[...]`     `a[x,y].ts`         a bracket class

    Splitting inside any of them tears the item into fragments that can never
    match a real path, and because the hook fails open the rule would silently
    stop firing rather than error. An unterminated quote or bracket consumes the
    rest of the text, which yields one item instead of garbage.
    """
    parts, buf, braces, brackets, quote = [], '', 0, 0, None
    for ch in text:
        if quote:
            if ch == quote:
                quote = None
            buf += ch
            continue
        if ch in ('"', "'"):
            quote = ch
            buf += ch
            continue
        if ch == '{':
            braces += 1
        elif ch == '}' and braces:
            braces -= 1
        elif ch == '[':
            brackets += 1
        elif ch == ']' and brackets:
            brackets -= 1
        if ch == ',' and not braces and not brackets:
            parts.append(buf)
            buf = ''
        else:
            buf += ch
    parts.append(buf)
    return parts


def expand_braces(pat):
    """Expand every `{a,b}` group (one level, multiple groups per pattern).

    A pattern whose braces are unbalanced is returned literally, unexpanded.
    """
    if pat.count('{') != pat.count('}'):
        return [pat]
    parts, alternatives, i = [], [], 0
    while i < len(pat):
        if pat[i] == '{':
            end = pat.find('}', i)
            if end == -1 or '{' in pat[i + 1:end]:
                return [pat]  # nested braces: literal, never garbage
            parts.append(None)
            alternatives.append(pat[i + 1:end].split(','))
            i = end + 1
        else:
            j = pat.find('{', i)
            j = len(pat) if j == -1 else j
            parts.append(pat[i:j])
            i = j
    if not alternatives:
        return [pat]
    out = []
    for combo in itertools.product(*alternatives):
        it, buf = iter(combo), []
        for p in parts:
            buf.append(next(it) if p is None else p)
        out.append(''.join(buf))
    return out


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
        elif pat[i] == '[':
            # A bracket class: `[!...]` negates; the class body is escaped so
            # `\` and `]` cannot break out of it. An unterminated `[` is literal.
            j = i + 1
            if j < len(pat) and pat[j] == '!':
                j += 1
            if j < len(pat) and pat[j] == ']':
                j += 1
            end = pat.find(']', j)
            if end == -1:
                out.append(re.escape(pat[i]))
                i += 1
            else:
                body = pat[i + 1:end]
                neg = body.startswith('!')
                if neg:
                    body = body[1:]
                body = body.replace('\\', '\\\\').replace(']', '\\]')
                out.append('[' + ('^' if neg else '') + body + ']')
                i = end + 1
        else:
            out.append(re.escape(pat[i]))
            i += 1
    out.append('$')
    return re.compile(''.join(out))


def _unquote(item):
    item = item.strip()
    if len(item) >= 2 and item[0] == item[-1] and item[0] in ('"', "'"):
        item = item[1:-1]
    return item.strip()


def parse_paths(frontmatter):
    paths, in_paths = [], False
    for line in frontmatter.splitlines():
        flow = re.match(r'^paths:\s*\[(.*)\]\s*$', line)
        if flow:
            paths.extend(p for p in (_unquote(x) for x in _split_top(flow.group(1))) if p)
            in_paths = False
            continue
        if re.match(r'^paths:\s*$', line):
            in_paths = True
            continue
        if in_paths:
            m = re.match(r'^\s*-\s*(.+?)\s*$', line)
            if m:
                # YAML-quoted globs: the installer writes "**/*.ts" because a
                # bare * is a YAML alias, so the quotes must come back off.
                item = _unquote(m.group(1))
                if item:
                    paths.append(item)
            elif line.strip() and not line[0].isspace():
                in_paths = False
    return paths


def matches(rel, patterns):
    for p in patterns:
        for expanded in expand_braces(p):
            if glob_to_regex(expanded).match(rel):
                return True
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return

    if not isinstance(data, dict):
        return
    proj = os.environ.get('CLAUDE_PROJECT_DIR') or data.get('cwd') or os.getcwd()
    tool_input = data.get('tool_input')
    file_path = tool_input.get('file_path', '') if isinstance(tool_input, dict) else ''
    if not isinstance(file_path, str) or not file_path:
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
    rules_root = os.path.join(proj, '.claude', 'rules')
    seen = set()
    total = 0
    for dirpath, dirnames, filenames in os.walk(rules_root, followlinks=False):
        if total > MAX_CONTEXT_BYTES:
            break  # the inner break only leaves one directory; stop the walk too
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
        for rule_file in (os.path.join(dirpath, f) for f in sorted(filenames) if f.endswith('.md')):
            if os.path.islink(rule_file):
                continue  # never follow symlinks: a loop or an external link is a context bomb
            real = os.path.realpath(rule_file)
            if real in seen:
                continue
            seen.add(real)
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
            if matches(rel, parse_paths(frontmatter)):
                chunks.append(body.strip())
                total += len(chunks[-1])
                if total > MAX_CONTEXT_BYTES:
                    break  # keep the injection bounded; a runaway rule set must not stall every Write

    if not chunks:
        return

    context = (
        'The file you are about to create (`' + safe_rel + '`) matches path-scoped '
        'rules that were NOT yet loaded into context (they load on read, not on '
        'create). Apply the following rule(s) to the content you write now:\n\n'
        + '\n\n---\n\n'.join(chunks)
    )
    # Printed at most once, as the last action of a successful run.
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'additionalContext': context,
        }
    }))


if __name__ == '__main__':
    try:
        main()
        sys.stdout.flush()  # a closed reader at shutdown must not turn into exit 120
    except BaseException:
        pass  # advisory hook: never block a Write because of our own failure
    sys.exit(0)
