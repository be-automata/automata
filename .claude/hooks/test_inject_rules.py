"""Tests for inject-rules.py (run: python3 .claude/hooks/test_inject_rules.py)."""
import importlib.util
import json
import os
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "inject-rules.py")
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

spec = importlib.util.spec_from_file_location("inject_rules", HOOK)
inject_rules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inject_rules)


def run_hook(payload, project_dir=ROOT):
    env = {**os.environ, "CLAUDE_PROJECT_DIR": project_dir, "PYTHONDONTWRITEBYTECODE": "1"}
    proc = subprocess.run(
        [sys.executable, HOOK], input=json.dumps(payload), capture_output=True, text=True, env=env
    )
    return proc.returncode, proc.stdout, proc.stderr


class GlobToRegex(unittest.TestCase):
    def test_double_star_matches_nested_and_root(self):
        r = inject_rules.glob_to_regex("**/*.ts")
        self.assertTrue(r.match("a/b/c.ts"))
        self.assertTrue(r.match("c.ts"))
        self.assertFalse(r.match("c.tsx"))

    def test_single_star_does_not_cross_directories(self):
        r = inject_rules.glob_to_regex("src/*.ts")
        self.assertTrue(r.match("src/a.ts"))
        self.assertFalse(r.match("src/x/a.ts"))

    def test_question_mark_is_single_char(self):
        r = inject_rules.glob_to_regex("a?.ts")
        self.assertTrue(r.match("ab.ts"))
        self.assertFalse(r.match("abc.ts"))


class ParsePaths(unittest.TestCase):
    def test_block_list_strips_yaml_quotes(self):
        fm = 'description: x\npaths:\n  - "**/*.ts"\n  - \'src/**\'\nalwaysApply: false\n'
        self.assertEqual(inject_rules.parse_paths(fm), ["**/*.ts", "src/**"])

    def test_missing_paths_yields_nothing(self):
        self.assertEqual(inject_rules.parse_paths("description: x\n"), [])


class EndToEnd(unittest.TestCase):
    def test_new_matching_ts_file_injects_rule(self):
        code, out, err = run_hook({"tool_input": {"file_path": "packages/utils/src/zz-new-file.ts"}})
        self.assertEqual(code, 0, err)
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("TypeScript Best Practices", ctx)

    def test_existing_file_is_silent(self):
        code, out, _ = run_hook({"tool_input": {"file_path": "packages/utils/src/retry.ts"}})
        self.assertEqual((code, out), (0, ""))

    def test_non_matching_file_is_silent(self):
        code, out, _ = run_hook({"tool_input": {"file_path": "docs/zz-new.md"}})
        self.assertEqual((code, out), (0, ""))

    def test_outside_project_path_is_silent(self):
        outside = os.path.abspath(os.sep + "zz-outside-hook-test.ts")  # no temp dir needed
        code, out, _ = run_hook({"tool_input": {"file_path": outside}})
        self.assertEqual((code, out), (0, ""))

    def test_crafted_filename_is_sanitised(self):
        code, out, _ = run_hook({"tool_input": {"file_path": "packages/utils/src/zz`x\n\x01new.ts"}})
        self.assertEqual(code, 0)
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("(`packages/utils/src/zzxnew.ts`)", ctx)

    def test_non_object_payloads_are_silent(self):
        for payload in ([1, 2], {"tool_input": "not a dict"}, {"tool_input": {"file_path": 7}}):
            code, out, err = run_hook(payload)
            self.assertEqual((code, out, err), (0, "", ""), payload)

    def test_symlink_loop_under_rules_is_ignored(self):
        link = os.path.join(ROOT, ".claude", "rules", "zz-loop-test")
        os.symlink("..", link)
        try:
            code, out, _ = run_hook({"tool_input": {"file_path": "packages/utils/src/zz-loop.ts"}})
        finally:
            os.unlink(link)
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertEqual(code, 0)
        self.assertEqual(ctx.count("TypeScript Best Practices"), 1)

    def test_context_cap_bounds_rules_across_directories(self):
        rules_dir = os.path.join(ROOT, ".claude", "rules")
        made = []
        big = "x" * (40 * 1024)
        try:
            for d in ("zz-cap-a", "zz-cap-b", "zz-cap-c"):
                os.makedirs(os.path.join(rules_dir, d), exist_ok=True)
                f = os.path.join(rules_dir, d, "rule.md")
                with open(f, "w") as fh:
                    fh.write('---\ndescription: cap test\npaths:\n  - "**/*.ts"\n---\n' + big + "\n")
                made.append(f)
            code, out, _ = run_hook({"tool_input": {"file_path": "packages/utils/src/zz-cap.ts"}})
        finally:
            for f in made:
                os.unlink(f)
                os.rmdir(os.path.dirname(f))
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
        self.assertEqual(code, 0)
        # three 40 KB rules plus the real one would be ~130 KB; the cap stops the walk after it is crossed
        self.assertLess(len(ctx), inject_rules.MAX_CONTEXT_BYTES + 41 * 1024)
        self.assertEqual(ctx.count("xxxx" * 10), 2 * (40 * 1024 // 40))

    def test_malformed_stdin_is_silent(self):
        env = {**os.environ, "CLAUDE_PROJECT_DIR": ROOT, "PYTHONDONTWRITEBYTECODE": "1"}
        proc = subprocess.run([sys.executable, HOOK], input="not json", capture_output=True, text=True, env=env)
        self.assertEqual((proc.returncode, proc.stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()
