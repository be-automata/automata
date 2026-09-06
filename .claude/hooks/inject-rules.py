#!/usr/bin/env python3
"""PreToolUse(Write) hook: inject path-scoped rules when creating a new file.

Works around the read-not-create caveat (#23478): `.claude/rules/*.md` files
with `paths:` frontmatter load on read, not on create. When Claude creates a
NEW file matching a rule's paths, this injects that rule's body as
additionalContext so it is in context before the file is written.

Fires only for: Write to a file that does NOT yet exist AND matches at least
one rule's `paths:` patterns. Otherwise it exits silently.

Never blocks: any failure (malformed stdin, unreadable rule, bad pattern,
missing interpreter feature) is swallowed and the process exits 0.
"""
import itertools
import json
import sys
import os
import re
import glob


def _split_top(text):
    """Split on commas that are not inside a brace group, so a flow-form item
    like "src/**/*.{ts,tsx}" stays one pattern."""
    parts, buf, depth = [], '', 0
    for ch in text:
        if ch == '{':
            depth += 1
        elif ch == '}' and depth:
            depth -= 1
        if ch == ',' and depth == 0:
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
    file_path = (data.get('tool_input') or {}).get('file_path', '')
    if not file_path:
        return

    abs_fp = file_path if os.path.isabs(file_path) else os.path.join(proj, file_path)
    # Only the caveat case: a brand-new file.
    if os.path.exists(abs_fp):
        return

    rel = os.path.relpath(abs_fp, proj)
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
        if matches(rel, parse_paths(frontmatter)):
            chunks.append(body.strip())

    if not chunks:
        return

    context = (
        'The file you are about to create (`' + rel + '`) matches path-scoped '
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
        pass
    sys.exit(0)
