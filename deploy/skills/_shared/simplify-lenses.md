### The four `/simplify` lenses — reuse, simplification, efficiency, altitude

The defect dimensions above find *bugs*. On a large diff they are not enough: the failure mode of a big PR is rarely a null check, it is **machinery that did not need to exist** — a helper that duplicates one three files over, an abstraction introduced for a single caller, a loop that re-reads what it already has. Those are invisible hunk-by-hunk, because each hunk looks fine.

Apply these four **only** when the diff is large — use **>10 changed files or >400 changed lines** as the trigger (the `gh pr diff` output in Trigger Context tells you both). On a small diff they are noise; skip them silently. These lenses judge quality, not correctness: a correctness bug you notice while applying them is reported under the defect dimensions, not here.

The four definitions below are Claude Code's `/simplify` skill, verbatim (the angles its four parallel cleanup agents take). For each finding give the `path:line`, a one-line summary, and the concrete cost — what is duplicated, wasted, or harder to maintain — plus the named replacement.

- **Reuse.** Flag new code that re-implements something the codebase already has — Grep shared/utility modules and files adjacent to the change, and name the existing helper to call instead.
- **Simplification.** Flag unnecessary complexity the diff adds: redundant or derivable state, copy-paste with slight variation, deep nesting, dead code left behind. Name the simpler form that does the same job.
- **Efficiency.** Flag wasted work the diff introduces: redundant computation or repeated I/O, independent operations run sequentially, blocking work added to startup or hot paths. Also flag long-lived objects built from closures or captured environments — they keep the entire enclosing scope alive for the object's lifetime (a memory leak when that scope holds large values); prefer a class/struct that copies only the fields it needs. Name the cheaper alternative.
- **Altitude.** Check that each change fixes the root cause at the right depth rather than patching a symptom with a fragile bandaid. Special cases layered on shared infrastructure are a sign the fix isn't deep enough — prefer the simpler, more general change to the underlying mechanism over adding special cases, and name that change.

Skip a finding whose fix would change intended behavior, would require changes well outside the reviewed diff, or that you judge to be a false positive — note the skip rather than arguing with it. (That is the skill's own apply-phase rule; here "note" means one line in the review body, not silence.)

**Severity for these four follows the shared rubric — it is not a softer scale.** Do not tag a lens finding `info` merely because it came from a cleanup pass; that is the exact inflation-in-reverse the rubric warns about. Judge the code: a duplicated rule whose two copies must agree, or a second validator that will drift from the first, is a real `warning`/`error` because it will cause a defect. A one-caller abstraction or a slightly roomier helper is `info`. The one thing these dimensions never are is `critical` — they describe code that works.

This partial is the single copy of the lenses every review skill reads; the including skill numbers them and adds its own stack's examples after it. Bump procedure: `docs/runbooks/toolchain-upgrade.md` § "`/simplify` lenses pin".

Vendored verbatim from Claude Code `2.1.261`'s bundled `simplify` skill (Phase 1 lens definitions and the Phase 2 skip rule) on 2026-09-04. The bundled skill has no public URL, so this copy is the pin.
