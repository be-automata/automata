# Security Audit

> Execute a comprehensive, framework-agnostic Security Audit. Detects project type at runtime and adapts security checks accordingly. Analyzes sensitive files, source code secrets, dependency vulnerabilities, and optionally uses Gemini AI for advanced analysis. Produces a severity-classified report.

# Security Audit - Modular Execution Plan

This plan executes a comprehensive, framework-agnostic Security Audit through
sequential, modular rules. Each step uses a specific rule that can be executed
independently and produces output that feeds into the final report.

## Agent Role & Context

**Role**: Security Auditor

## Your Core Expertise

You are a master at:
- **Framework-Agnostic Security Auditing**: Detecting project type at runtime
  and adapting security checks accordingly
- **Sensitive File Detection**: Identifying exposed credentials, API keys,
  secrets, and sensitive files across any project type
- **Source Code Secret Scanning**: Detecting hardcoded secrets, credentials,
  and dangerous patterns in source code
- **Dependency Vulnerability Analysis**: Running package-manager-native
  vulnerability scans (npm audit, pub outdated, pip audit, etc.)
- **Dependency Age Analysis**: Identifying outdated and deprecated
  dependencies across ecosystems
- **AI-Powered Security Analysis**: Leveraging Gemini CLI for advanced
  vulnerability detection when available
- **Quantitative Security Scoring**: Computing per-section scores using
  weighted rubrics (5 sections, weighted formula) and mapping to security
  posture labels (Strong/Fair/Weak/Critical)
- **Evidence-Based Reporting**: Producing actionable security reports with
  file paths, line numbers, severity classifications, and quantitative scores

**Responsibilities**:
- Detect project type automatically before running any analysis
- Execute security checks adapted to the detected technology
- Report findings objectively based on evidence found in the repository
- Stop execution immediately if MANDATORY steps fail
- Never invent or assume information - report "Not found" if evidence is missing
- Gracefully skip Gemini analysis if Gemini CLI is unavailable

**Expected Behavior**:
- **Professional and Evidence-Based**: All findings must be supported by
  actual repository evidence
- **Objective Reporting**: Distinguish clearly between HIGH, MEDIUM, and
  LOW severity findings
- **Explicit Documentation**: Document what was checked, what was found,
  and what is missing
- **Error Handling**: Stop execution on MANDATORY step failures; continue
  with warnings for non-critical issues
- **No Assumptions**: If something cannot be proven by repository evidence,
  write "Not found" and specify what would prove it

**Critical Rules**:
- **NEVER recommend CODEOWNERS or SECURITY.md files** - these are governance
  decisions, not technical requirements
- **NEVER recommend operational documentation** (runbooks, deployment
  procedures, monitoring) - focus on technical security only

## PROJECT DETECTION (execute first)

Before any analysis, detect the project type:
- `pubspec.yaml` present -> Flutter/Dart project (scan `*.dart`, check
  `android/.gitignore`, etc.)
- `package.json` with `@nestjs/core` -> NestJS project (scan `*.ts`, check
  auth guards, OWASP, etc.)
- `package.json` without `@nestjs/core` -> Node.js project (scan `*.ts`/`*.js`)
- `go.mod` -> Go project
- `Cargo.toml` -> Rust project
- `pyproject.toml` or `requirements.txt` -> Python project
- `build.gradle` or `build.gradle.kts` -> Java/Kotlin Gradle project
- `pom.xml` -> Java/Kotlin Maven project
- `Package.swift` -> Swift SPM project
- `Podfile` -> Swift/ObjC CocoaPods project
- `*.sln` or `*.csproj` -> .NET project
- Fallback -> Generic project (scan common patterns)

**Project Detection Priority** (when multiple manifests exist):
1. pubspec.yaml, 2. package.json, 3. go.mod, 4. Cargo.toml, 5. pyproject.toml,
6. build.gradle/build.gradle.kts, 7. pom.xml, 8. Package.swift, 9. Podfile,
10. .sln/.csproj. Only the first match is audited. For monorepos with multiple
stacks, run the audit from subdirectories or use multi-tech detection (if
enabled).

## Step 1. Tool Detection and Setup

Goal: Detect Gemini CLI availability and configure the security toolchain.

Read and follow the instructions in `references/tool-installer.md`

**Integration**: Save tool detection results for subsequent steps.

## Step 2. Sensitive File Analysis

Goal: Identify sensitive files, check .gitignore coverage across all project
directories, and detect exposed configuration files.

Read and follow the instructions in `references/file-analysis.md`

**Integration**: Save file analysis findings for the security report.

## Step 3. Source Code Secret Scanning

Goal: Search source code for dangerous secret patterns, hardcoded
credentials, API keys, and tokens.

Read and follow the instructions in `references/secret-patterns.md`

**Integration**: Save secret scanning findings for the security report.

## Step 4. Gitleaks Scan (Optional)

Goal: Scan repository for secrets in working directory and git history
using Gitleaks.

Read and follow the instructions in `references/gitleaks.md`

**Integration**: Save Gitleaks findings for Secret Detection section. If
Gitleaks not installed, add install recommendation to report. Report
generator applies "Secrets in git history: -15" if step_04 finds
GIT_HISTORY_FINDINGS > 0.

## Step 5. Dependency Vulnerability Audit

Goal: Run package-manager-native vulnerability scans and identify outdated
or vulnerable dependencies.

Read and follow the instructions in `references/dependency-audit.md`

**Integration**: Save dependency audit findings for the security report.

## Step 6. Dependency Age Audit

Goal: Identify outdated and deprecated dependencies across the project.

Read and follow the instructions in `references/dependency-age.md`

**Integration**: Save dependency age findings for the Dependency Security
section of the report. Report generator pulls outdated/deprecated counts
and lists from step_06 artifact.

## Step 7. Trivy Vulnerability Scan (Optional)

Goal: Run Trivy filesystem scan for known vulnerabilities in dependencies
and configurations. Skips gracefully if Trivy is not installed.

Read and follow the instructions in `references/trivy.md`

**Integration**: Save Trivy scan findings for the security report. If
Trivy is not installed, add installation recommendation to report.

## Step 8. SAST Analysis

Goal: Run basic SAST-style grep for OWASP vulnerability patterns
(SQL injection, XSS, path traversal, eval/code injection) per detected
project type, plus a Firebase Auth abuse check (App Check enforcement
and SMS region policy, including a live `gcloud`-based verification
when available) when Firebase Auth is detected. Findings feed
Consolidated Findings as LOW/MEDIUM severity.

Read and follow the instructions in `references/sast.md`

**Integration**: Save SAST findings for Consolidated Findings in the
security report. Findings do not affect main section scores.

## Step 9. Gemini AI Security Analysis (Optional)

Goal: Execute advanced AI-powered security analysis using the Gemini CLI
Security extension if available.

Read and follow the instructions in `references/gemini-analysis.md`

**Integration**: Save Gemini analysis findings for the security report.
Skip gracefully if Gemini CLI is unavailable.

## Step 10. Generate Security Report

Goal: Synthesize all findings into a comprehensive security audit report
with quantitative scoring, severity classifications, and actionable
recommendations.

Read and follow the instructions in `references/report-generator.md`

**Integration**: This rule integrates all previous analysis results and
generates the final security report. You MUST compute all 5 section scores
using the scoring rubrics BEFORE writing any report content. A report
without computed scores is INVALID.

**Report Sections** (13 sections with quantitative scoring):
- Security Scoring Breakdown (5 scored lines + Overall + Posture)
- Executive Summary with Overall Score
- Scored Detail Sections (5 sections, dynamically ordered by score ascending — lowest first):
  - Sensitive File Protection (scored, weight 25%)
  - Secret Detection (scored, weight 30%)
  - Dependency Security (scored, weight 20%)
  - Supply Chain Integrity (scored, weight 10%)
  - Security Automation & CI/CD (scored, weight 15%)
- Consolidated Findings by Severity (HIGH, MEDIUM, LOW)
- Remediation Priority Matrix
- Gemini AI Analysis results (if available)
- Project Detection Results
- Appendix: Evidence Index
- Scan Metadata

**Scoring Requirement**: Every scored section MUST include: Score line
with [Score]/100 ([Label]) format, Score Breakdown (Base, deductions/additions,
Final), Key Findings, Evidence, Risks, and Recommendations.

## Step 11. Validate and Export Security Report

Goal: Validate the generated report against structural and Markdown formatting
rules, then save the final Markdown report.

Read and follow the instructions in `references/report-format-enforcer.md`

**Validation**: Read the generated report and validate ALL structural checks
from the format enforcer rule: exactly 13 sections, Section 1 has 5 scored
lines with weights + Overall + Formula + Posture, Sections 3-7 have Score
lines, sections are ordered by score ascending, score labels match ranges,
proper Markdown syntax. Fix any issues in-place. If scores are missing entirely,
re-run step 10 before exporting.

**Export**: Save the validated report to `./reports/security_audit.md`

**Format**: Markdown-formatted report (use proper Markdown syntax,
use # headings, **bold** markers, and `backtick` code references).

**Command**:
```bash
mkdir -p reports
# Save validated report to ./reports/security_audit.md
```

## Execution Summary

**Total Rules**: 10 analysis rules + 1 format enforcement rule

**Rule Execution Order**:
1. Read and follow the instructions in `references/tool-installer.md` (MANDATORY - tool detection) {model: cheap}
2. Read and follow the instructions in `references/file-analysis.md` {model: cheap}
3. Read and follow the instructions in `references/secret-patterns.md` {model: cheap}
4. Read and follow the instructions in `references/gitleaks.md` (optional - skips if Gitleaks not installed) {model: cheap}
5. Read and follow the instructions in `references/dependency-audit.md` {model: mid}
6. Read and follow the instructions in `references/dependency-age.md` {model: mid}
7. Read and follow the instructions in `references/trivy.md` (optional - skips if Trivy not installed) {model: mid}
8. Read and follow the instructions in `references/sast.md` (SAST OWASP patterns, LOW/MEDIUM findings) {model: cheap}
9. Read and follow the instructions in `references/gemini-analysis.md` (optional - skips if Gemini unavailable) {model: mid}
10. Read and follow the instructions in `references/report-generator.md` (generates 13-section report with quantitative scoring) {model: frontier}

**Post-Generation**: Read and follow the instructions in `references/report-format-enforcer.md` to validate and fix
the report (runs automatically after step 10) {model: frontier}

**Scoring System**:
- 5 scored sections with weighted rubrics (0-100 each)
- Overall Score computed via weighted formula
- Security Posture mapped from Overall Score: Strong (85-100), Fair (70-84),
  Weak (50-69), Critical (0-49)
- Security Scoring Breakdown provides immediate CTO-level visibility
- Scored sections ordered by score ascending (weakest areas first)

**Benefits of Modular Approach**:
- Each rule can be executed independently
- Framework-agnostic with runtime project detection
- Outputs can be saved and reused
- Gemini analysis is optional and gracefully degraded
- Clear separation of concerns
- Quantitative scoring enables objective comparison across audits
- Works as standalone or after health audit

## Subagent Dispatch (in-session)

This section describes the **in-session path** — when Claude Code dispatches subagents via the Agent tool within a single session. The Rule Execution Order above is the **CLI path** (`somnio run`), which runs steps sequentially. Both paths produce the same report; they differ in how steps are scheduled and which model tier runs each step.

**Entry point**: `agents/orchestrator.md` (model: mid)

The orchestrator reads this SKILL.md for scope context, then fans out to analysis subagents in dependency-ordered waves. It validates each expected artifact before advancing to the next wave. On a missing artifact it retries once, then logs the gap and lets the report-writer handle it via the rejection criteria.

### Wave Plan

| Wave | Mode | Agents dispatched | Tier |
|------|------|-------------------|------|
| Wave 0 | Sequential (stop-on-failure) | `tool-installer` | cheap |
| Wave 1 | Parallel | `file-analyzer`, `secret-scanner`, `sast-analyzer` | cheap |
| Wave 2 | Sequential | `dependency-analyzer` | mid |
| Wave 3 | Conditional (skip if GEMINI_AVAILABLE=false) | `gemini-analyzer` | mid |
| Wave 4 | Sequential | `report-writer` | frontier |

### Dispatch Table

| Agent file | Tier | References / steps covered | Artifact(s) written |
|---|---|---|---|
| `agents/tool-installer.md` | cheap | `references/tool-installer.md` (step 1) | `reports/.artifacts/step_01_security_tool_installer.md` |
| `agents/file-analyzer.md` | cheap | `references/file-analysis.md` (step 2) | `reports/.artifacts/step_02_security_file_analysis.md` |
| `agents/secret-scanner.md` | cheap | `references/secret-patterns.md` (step 3) + `references/gitleaks.md` (step 4) | `reports/.artifacts/step_03_security_secret_patterns.md`, `reports/.artifacts/step_04_security_gitleaks.md` |
| `agents/sast-analyzer.md` | cheap | `references/sast.md` (step 8) | `reports/.artifacts/step_08_security_sast.md` |
| `agents/dependency-analyzer.md` | mid | `references/dependency-audit.md` (step 5) + `references/dependency-age.md` (step 6) + `references/trivy.md` (step 7) | `reports/.artifacts/step_05_security_dependency_audit.md`, `reports/.artifacts/step_06_security_dependency_age.md`, `reports/.artifacts/step_07_security_trivy.md` |
| `agents/gemini-analyzer.md` | mid | `references/gemini-analysis.md` (step 9) | `reports/.artifacts/step_09_security_gemini_analysis.md` |
| `agents/report-writer.md` | frontier | `references/report-generator.md` (step 10) + `references/report-format-enforcer.md` (step 11) + `assets/report-template.md` | `reports/security_audit.md`, `reports/security_audit.json`, `reports/.history/last_scores.json` |

**Model tiers** are provider-neutral symbolic names. The CLI transformer resolves them to concrete model IDs at install time (e.g. for Claude: cheap→haiku, mid→sonnet, frontier→opus).

## Report Metadata (MANDATORY)

Every generated report MUST include a metadata block at the very end. This is non-negotiable — never omit it.

To resolve the source and version:
1. Look for `.claude-plugin/plugin.json` by traversing up from this skill's directory
2. If found, read `name` and `version` from that file (plugin context)
3. If not found, use `Somnio CLI` as the name and `unknown` as the version (CLI context)

Include this block at the very end of the report:

```
---
Generated by: [plugin name or "Somnio CLI"] v[version]
Skill: security-audit
Date: [YYYY-MM-DD]
Somnio AI Tools: https://github.com/somnio-software/somnio-ai-tools
---
```

---

# Rule Reference

## Security Dependency Age

> Identify outdated and deprecated dependencies across the project. Framework-agnostic with runtime project type detection. Produces structured output for dependency age and deprecation analysis.

**File pattern**: `*`

Goal: Identify outdated and deprecated dependencies, produce
structured output for the Security Audit report.

PROJECT DETECTION (execute first):
- Read reports/.artifacts/step_01_security_tool_installer.md for
  PROJECT_DETECTION_RESULTS (format: type@path|type@path...)
- If multiple projects: for each type@path, cd to path and run
  dependency age check for that project; concatenate all results
- If single project: run from project root
- Per-type tools: Flutter (pub outdated), Node (npm outdated),
  Go (go list -m -u), Rust (cargo outdated), Python (pip),
  Gradle/Maven, Swift, .NET (dotnet list package --outdated)

DEPENDENCY AGE PER PROJECT TYPE:

Flutter/Dart:
```bash
echo "=== Flutter/Dart Dependency Age ==="
fvm flutter pub outdated 2>/dev/null || flutter pub outdated 2>/dev/null \
  || dart pub outdated 2>/dev/null || echo "pub outdated failed"
# Parse output for "discontinued" or "deprecated" in package names
```

NestJS/Node.js:
```bash
echo "=== Node.js Dependency Age ==="
if [ -f "pnpm-lock.yaml" ]; then
  PM="pnpm"
elif [ -f "yarn.lock" ]; then
  PM="yarn"
else
  PM="npm"
fi
echo "Package manager: $PM"
$PM outdated 2>/dev/null | head -50 || echo "outdated check skipped"
# Check for deprecated packages (npm only): list direct deps and check
# npm view <pkg> deprecated 2>/dev/null for each
if [ "$PM" = "npm" ] && [ -f "package.json" ]; then
  echo ""
  echo "=== Deprecated Package Check (npm) ==="
  for pkg in $(node -e "try{const p=require('./package.json'); \
    Object.keys({...p.dependencies,...(p.devDependencies||{})}).forEach( \
    k=>console.log(k));}catch(e){}" 2>/dev/null); do
    dep=$(npm view "$pkg" deprecated 2>/dev/null)
    [ -n "$dep" ] && echo "$pkg: $dep"
  done | head -20 || true
fi
```

Go:
```bash
echo "=== Go Dependency Age ==="
go list -m -u all 2>/dev/null | head -50 || echo "go list failed"
```

Rust:
```bash
echo "=== Rust Dependency Age ==="
if command -v cargo-outdated &> /dev/null; then
  cargo outdated 2>/dev/null | head -50 || echo "cargo outdated failed"
else
  cargo tree --depth 1 2>/dev/null | head -30
  echo "Tip: install cargo-outdated for better analysis (cargo install cargo-outdated)"
fi
```

Python:
```bash
echo "=== Python Dependency Age ==="
pip list --outdated 2>/dev/null | head -50 || echo "pip list --outdated failed"
```

Java/Kotlin (Gradle):
```bash
echo "=== Java/Kotlin Gradle Dependency Age ==="
if [ -f "gradlew" ]; then
  ./gradlew dependencyUpdates 2>/dev/null | head -80 \
    || echo "dependencyUpdates failed (requires gradle-versions-plugin)"
else
  echo "No gradlew found"
fi
```

Java/Kotlin (Maven):
```bash
echo "=== Java/Kotlin Maven Dependency Age ==="
if [ -f "pom.xml" ]; then
  mvn versions:display-dependency-updates 2>/dev/null | head -80 \
    || echo "versions:display-dependency-updates failed"
else
  echo "No pom.xml found"
fi
```

Swift (CocoaPods):
```bash
echo "=== Swift CocoaPods Dependency Age ==="
if [ -f "Podfile" ] && command -v pod &> /dev/null; then
  pod outdated 2>/dev/null | head -50 || echo "pod outdated failed"
else
  echo "Podfile not found or CocoaPods not installed"
fi
```

Swift (SPM):
```bash
echo "=== Swift Package Manager Dependency Age ==="
if [ -f "Package.swift" ] && command -v swift &> /dev/null; then
  swift package show-dependencies 2>/dev/null | head -50 \
    || echo "swift package show-dependencies failed"
  echo "Note: SPM has no native outdated check; consider CocoaPods or \
    manual version comparison"
else
  echo "Package.swift not found or swift not in PATH"
fi
```

.NET:
```bash
echo "=== .NET Dependency Age ==="
if command -v dotnet &> /dev/null; then
  PROJ=$(find . -maxdepth 2 -name "*.sln" 2>/dev/null | head -1)
  [ -z "$PROJ" ] && PROJ=$(find . -maxdepth 2 -name "*.csproj" 2>/dev/null | head -1)
  if [ -n "$PROJ" ]; then
    dotnet list "$PROJ" package --outdated 2>/dev/null | head -80 \
      || echo "dotnet list package --outdated failed"
    dotnet list "$PROJ" package --deprecated 2>/dev/null | head -50 \
      || echo "dotnet list package --deprecated failed"
  else
    echo "No .sln or .csproj found"
  fi
else
  echo "dotnet CLI not found"
fi
```

OUTPUT FORMAT (mandatory - structure the analysis for report integration):

Include these sections in the artifact output:

1. OUTDATED COUNT: [integer] (direct dependencies; add transitive if available)
2. DEPRECATED COUNT: [integer]
3. OUTDATED LIST: For each outdated package, list:
   - Package name, Current version, Latest version, Delta (major/minor/patch)
4. DEPRECATED LIST: For each deprecated package:
   - Package name, Deprecation message (if available)
5. SUMMARY: Brief recommendation (prioritize major updates, replace deprecated)

ARTIFACT SAVE:
Save the full analysis to: reports/.artifacts/step_06_security_dependency_age.md

Run this after completing the analysis:
mkdir -p reports/.artifacts

## Security Dependency Audit

> Run package-manager-native vulnerability scans and identify outdated or vulnerable dependencies. Framework-agnostic with runtime project type detection.

**File pattern**: `*`

Goal: Run package-manager-native vulnerability scans and identify
outdated or vulnerable dependencies.

PROJECT DETECTION (execute first):
- Read reports/.artifacts/step_01_security_tool_installer.md for
  PROJECT_DETECTION_RESULTS (format: type@path|type@path...)
- If multiple projects: for each type@path, cd to path and run
  dependency audit for that project; concatenate all results
- If single project: run from project root
- Per-type tools: Flutter (pub), Node/NestJS (npm/yarn/pnpm),
  Go (go, govulncheck), Rust (cargo audit), Python (pip audit),
  Gradle/Maven, Swift (pod, swift), .NET (dotnet)

DEPENDENCY AUDIT PER PROJECT TYPE:

Flutter/Dart:
```bash
echo "=== Flutter/Dart Dependency Audit ==="
# Check for outdated packages
fvm flutter pub outdated 2>/dev/null || flutter pub outdated 2>/dev/null \
  || echo "pub outdated failed"

# Check dependency tree
fvm flutter pub deps --style=compact 2>/dev/null | head -50 \
  || flutter pub deps --style=compact 2>/dev/null | head -50 \
  || echo "pub deps failed"

# Classify path: and git: dependencies across all pubspec.yaml files
echo ""
echo "=== Path/Git Dependency Classification ==="
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
echo "Repo root: $REPO_ROOT"

# Use Python to reliably parse YAML path: entries and classify them
find . -name "pubspec.yaml" -not -path "*/.*" -not -path "*/build/*" 2>/dev/null | while IFS= read -r pubspec; do
  PUBSPEC_DIR=$(dirname "$pubspec")
  python3 - "$pubspec" "$PUBSPEC_DIR" "$REPO_ROOT" <<'PYEOF' 2>/dev/null
import sys, os, re

pubspec_path, pubspec_dir, repo_root = sys.argv[1], sys.argv[2], sys.argv[3]
repo_root = os.path.realpath(repo_root)

try:
    content = open(pubspec_path).read()
except:
    sys.exit(0)

current_pkg = None
for line in content.splitlines():
    pkg_match = re.match(r'^  (\S+):\s*$', line)
    if pkg_match:
        current_pkg = pkg_match.group(1)
        continue
    path_match = re.match(r'^\s+path:\s+(.+)$', line)
    if path_match and current_pkg:
        raw = path_match.group(1).strip().strip('"\'')
        if os.path.isabs(raw):
            resolved = os.path.realpath(raw)
        else:
            resolved = os.path.realpath(os.path.join(pubspec_dir, raw))
        if resolved.startswith(repo_root):
            print(f"PATH_INTERNAL|{current_pkg}|{raw}")
        else:
            print(f"PATH_EXTERNAL|{current_pkg}|{raw}")
        current_pkg = None
        continue
    git_match = re.match(r'^\s+git:\s*$', line)
    if git_match and current_pkg:
        print(f"GIT_SOURCED|{current_pkg}")
        current_pkg = None
PYEOF
done

echo ""
echo "Classification legend:"
echo "  PATH_INTERNAL = path resolves inside repo root — in-repo/monorepo package, NOT a supply-chain risk"
echo "  PATH_EXTERNAL = absolute path or resolves outside repo root — flag as supply-chain risk (-5 each)"
echo "  GIT_SOURCED   = git-sourced dep — flag as supply-chain risk (-10 each)"
```

NestJS/Node.js:
```bash
echo "=== Node.js Dependency Audit ==="
# Detect package manager
if [ -f "pnpm-lock.yaml" ]; then
  PM="pnpm"
elif [ -f "yarn.lock" ]; then
  PM="yarn"
else
  PM="npm"
fi
echo "Package manager: $PM"

# Run vulnerability audit
if [ "$PM" = "npm" ]; then
  npm audit --json 2>/dev/null | head -100 || npm audit 2>/dev/null | head -50
elif [ "$PM" = "yarn" ]; then
  yarn audit --json 2>/dev/null | head -100 || yarn audit 2>/dev/null | head -50
elif [ "$PM" = "pnpm" ]; then
  pnpm audit --json 2>/dev/null | head -100 || pnpm audit 2>/dev/null | head -50
fi

# Check for outdated packages
$PM outdated 2>/dev/null | head -30 || echo "outdated check skipped"

# Verify lock file integrity
if [ "$PM" = "npm" ]; then
  echo "Lock file: package-lock.json $([ -f package-lock.json ] && echo 'EXISTS' || echo 'MISSING')"
elif [ "$PM" = "yarn" ]; then
  echo "Lock file: yarn.lock $([ -f yarn.lock ] && echo 'EXISTS' || echo 'MISSING')"
elif [ "$PM" = "pnpm" ]; then
  echo "Lock file: pnpm-lock.yaml $([ -f pnpm-lock.yaml ] && echo 'EXISTS' || echo 'MISSING')"
fi
```

Go:
```bash
echo "=== Go Dependency Audit ==="
# Check for vulnerabilities using govulncheck if available
if command -v govulncheck &> /dev/null; then
  govulncheck ./... 2>/dev/null | head -50 || echo "govulncheck failed"
else
  echo "govulncheck not installed (install: go install golang.org/x/vuln/cmd/govulncheck@latest)"
fi
# Check for outdated modules
go list -m -u all 2>/dev/null | head -30 || echo "go list failed"
```

Rust:
```bash
echo "=== Rust Dependency Audit ==="
if command -v cargo-audit &> /dev/null; then
  cargo audit 2>/dev/null | head -50 || echo "cargo audit failed"
else
  echo "cargo-audit not installed (install: cargo install cargo-audit)"
fi
```

Python:
```bash
echo "=== Python Dependency Audit ==="
if command -v pip-audit &> /dev/null; then
  pip-audit 2>/dev/null | head -50 || echo "pip-audit failed"
elif command -v safety &> /dev/null; then
  safety check 2>/dev/null | head -50 || echo "safety check failed"
else
  echo "No Python audit tool found (install: pip install pip-audit)"
fi
```

Java/Kotlin (Gradle):
```bash
echo "=== Java/Kotlin Gradle Dependency Audit ==="
if [ -f "gradlew" ]; then
  ./gradlew dependencyCheckAnalyze 2>/dev/null | head -80 \
    || echo "dependencyCheckAnalyze failed (requires OWASP plugin)"
  ./gradlew dependencies --configuration compileClasspath 2>/dev/null \
    | head -50 || echo "dependencies failed"
else
  echo "No gradlew found"
fi
```

Java/Kotlin (Maven):
```bash
echo "=== Java/Kotlin Maven Dependency Audit ==="
if [ -f "pom.xml" ]; then
  mvn dependency-check:check 2>/dev/null | head -80 \
    || echo "dependency-check failed (requires OWASP plugin)"
  mvn dependency:tree 2>/dev/null | head -50 || echo "dependency:tree failed"
else
  echo "No pom.xml found"
fi
```

Swift (CocoaPods):
```bash
echo "=== Swift CocoaPods Dependency Audit ==="
if [ -f "Podfile" ] && command -v pod &> /dev/null; then
  pod outdated 2>/dev/null | head -30 || echo "pod outdated failed"
  pod list 2>/dev/null | head -30 || echo "pod list failed"
else
  echo "Podfile not found or CocoaPods not installed"
fi
```

Swift (SPM):
```bash
echo "=== Swift Package Manager Audit ==="
if [ -f "Package.swift" ] && command -v swift &> /dev/null; then
  swift package show-dependencies 2>/dev/null | head -50 \
    || echo "swift package show-dependencies failed"
  echo "Note: SPM has no built-in vulnerability scan; consider Xcode \
    or third-party tools"
else
  echo "Package.swift not found or swift not in PATH"
fi
```

.NET:
```bash
echo "=== .NET Dependency Audit ==="
if command -v dotnet &> /dev/null; then
  PROJ=$(find . -maxdepth 2 -name "*.sln" 2>/dev/null | head -1)
  [ -z "$PROJ" ] && PROJ=$(find . -maxdepth 2 -name "*.csproj" 2>/dev/null | head -1)
  if [ -n "$PROJ" ]; then
    dotnet list "$PROJ" package --vulnerable --include-transitive 2>/dev/null \
      | head -80 || echo "dotnet list package --vulnerable failed"
  else
    echo "No .sln or .csproj found"
  fi
else
  echo "dotnet CLI not found"
fi
```

AUTOMATED SECURITY TOOLING CHECK (ALL project types):
```bash
echo ""
echo "=== Automated Security Tooling ==="

# --- Automated Dependency Updates (platform-agnostic) ---
# Priority: Dependabot (GitHub) > Renovate (any platform) > GitLab built-in DS
DEP_UPDATE_TOOL=""
if [ -f ".github/dependabot.yml" ] || [ -f ".github/dependabot.yaml" ]; then
  DEP_UPDATE_TOOL="Dependabot"
  cat .github/dependabot.y*ml 2>/dev/null | head -30
elif [ -f "renovate.json" ] || [ -f "renovate.json5" ] || \
     [ -f ".renovaterc" ] || [ -f ".renovaterc.json" ] || [ -f ".renovaterc.json5" ] || \
     [ -f ".github/renovate.json" ] || [ -f ".gitlab/renovate.json" ] || \
     ([ -f "package.json" ] && grep -q '"renovate"' package.json 2>/dev/null); then
  DEP_UPDATE_TOOL="Renovate"
elif [ -f ".gitlab-ci.yml" ] && grep -qE "dependency.scanning|Dependency-Scanning\.gitlab-ci\.yml|gemnasium|DEPENDENCY_SCANNING" .gitlab-ci.yml 2>/dev/null; then
  DEP_UPDATE_TOOL="GitLab Dependency Scanning"
fi

if [ -n "$DEP_UPDATE_TOOL" ]; then
  echo "DepUpdate: CONFIGURED ($DEP_UPDATE_TOOL)"
else
  echo "DepUpdate: NOT CONFIGURED"
fi

# --- CI Platform Detection ---
echo ""
echo "=== CI Platform Detection ==="
CI_DETECTED=""
[ -d ".github/workflows" ]       && echo "CI: GitHub Actions (.github/workflows/)"           && CI_DETECTED="YES"
[ -f ".gitlab-ci.yml" ]          && echo "CI: GitLab CI (.gitlab-ci.yml)"                    && CI_DETECTED="YES"
[ -f "bitbucket-pipelines.yml" ] && echo "CI: Bitbucket Pipelines (bitbucket-pipelines.yml)" && CI_DETECTED="YES"
[ -z "$CI_DETECTED" ] && echo "CI: NONE DETECTED"

# --- CI/CD Security Scanning (GitHub Actions, GitLab CI, Bitbucket Pipelines) ---
echo ""
echo "=== CI Security Scanning ==="
SECURITY_KEYWORDS="npm audit|yarn audit|pnpm audit|snyk|trivy|grype|safety|pip.audit|cargo.audit|govulncheck|dependencyCheck|dependency-check|dotnet.*package|dependency.scanning|container.scanning|secret.detection|gemnasium"

CI_SCAN_FOUND=""
[ -d ".github/workflows" ]       && grep -rlE "$SECURITY_KEYWORDS" .github/workflows/ 2>/dev/null      | grep -q . && CI_SCAN_FOUND="YES" && echo "Security scanning in GitHub Actions: YES"
[ -f ".gitlab-ci.yml" ]          && grep -qE  "$SECURITY_KEYWORDS" .gitlab-ci.yml 2>/dev/null          && CI_SCAN_FOUND="YES" && echo "Security scanning in GitLab CI: YES"
[ -f "bitbucket-pipelines.yml" ] && grep -qE  "$SECURITY_KEYWORDS" bitbucket-pipelines.yml 2>/dev/null && CI_SCAN_FOUND="YES" && echo "Security scanning in Bitbucket Pipelines: YES"
[ -z "$CI_SCAN_FOUND" ] && echo "CI_SECURITY_SCANNING: NOT CONFIGURED"

# --- CI runs on PRs / MRs ---
echo ""
echo "=== CI PR/MR Trigger Detection ==="
PR_TRIGGER_FOUND=""
[ -d ".github/workflows" ]       && grep -rlE "pull_request"                 .github/workflows/ 2>/dev/null | grep -q . && PR_TRIGGER_FOUND="YES" && echo "PR trigger: GitHub Actions pull_request"
[ -f ".gitlab-ci.yml" ]          && grep -qE  "merge_request|merge_requests"  .gitlab-ci.yml 2>/dev/null               && PR_TRIGGER_FOUND="YES" && echo "PR trigger: GitLab CI merge_request"
[ -f "bitbucket-pipelines.yml" ] && grep -q   "pull-requests"                 bitbucket-pipelines.yml 2>/dev/null        && PR_TRIGGER_FOUND="YES" && echo "PR trigger: Bitbucket Pipelines pull-requests"
[ -z "$PR_TRIGGER_FOUND" ] && echo "CI_PR_TRIGGERS: NOT CONFIGURED"

# --- Lock file validation in CI ---
echo ""
echo "=== Lock File Validation in CI ==="
LOCKFILE_PATTERN="npm ci|--frozen-lockfile|cargo --locked|pip install --require-hashes|poetry install --no-root"
LOCKFILE_CI_FOUND=""
[ -d ".github/workflows" ]       && grep -rlE "$LOCKFILE_PATTERN" .github/workflows/ 2>/dev/null       | grep -q . && LOCKFILE_CI_FOUND="YES" && echo "Lock file validation in GitHub Actions: YES"
[ -f ".gitlab-ci.yml" ]          && grep -qE  "$LOCKFILE_PATTERN" .gitlab-ci.yml 2>/dev/null           && LOCKFILE_CI_FOUND="YES" && echo "Lock file validation in GitLab CI: YES"
[ -f "bitbucket-pipelines.yml" ] && grep -qE  "$LOCKFILE_PATTERN" bitbucket-pipelines.yml 2>/dev/null  && LOCKFILE_CI_FOUND="YES" && echo "Lock file validation in Bitbucket Pipelines: YES"
[ -z "$LOCKFILE_CI_FOUND" ] && echo "CI_LOCKFILE_VALIDATION: NOT CONFIGURED"

# --- Snyk ---
if [ -f ".snyk" ]; then
  echo "Snyk: CONFIGURED"
else
  echo "Snyk: NOT CONFIGURED"
fi

# --- Pre-commit hooks for security ---
if [ -f ".pre-commit-config.yaml" ]; then
  echo "Pre-commit: CONFIGURED"
  grep -E "gitleaks|detect-secrets|secret|security" .pre-commit-config.yaml 2>/dev/null || echo "No security hooks found"
else
  echo "Pre-commit: NOT CONFIGURED"
fi
```

ARTIFACT SAVE (mandatory):
Save the full analysis output to: reports/.artifacts/step_05_security_dependency_audit.md
Run before finishing: mkdir -p reports/.artifacts

Output format:
- Detected project type and package manager
- Vulnerability scan results (count by severity: critical, high, medium, low)
- Outdated dependencies summary
- Lock file integrity status
- Automated dependency updates status: DepUpdate CONFIGURED/NOT CONFIGURED with tool name (Dependabot / Renovate / GitLab Dependency Scanning / equivalent)
- CI platform(s) detected (GitHub Actions / GitLab CI / Bitbucket Pipelines)
- CI security scanning status per platform (CI_SECURITY_SCANNING CONFIGURED/NOT CONFIGURED)
- CI PR/MR trigger status (CI_PR_TRIGGERS CONFIGURED/NOT CONFIGURED)
- CI lock file validation status (CI_LOCKFILE_VALIDATION CONFIGURED/NOT CONFIGURED)
- Snyk status
- Pre-commit security hooks status
- Path dependency classification (Flutter/Dart and Node file: deps):
  - PATH_INTERNAL_COUNT: [N] — in-repo/monorepo packages (NOT a supply-chain risk, do not penalise)
  - PATH_INTERNAL_LIST: [package names] — informational only
  - PATH_EXTERNAL_COUNT: [N] — absolute or out-of-repo paths (supply-chain risk, penalise -5 each)
  - PATH_EXTERNAL_LIST: [package names with paths]
  - GIT_SOURCED_COUNT: [N] — git-sourced deps (supply-chain risk, penalise -10 each)
  - GIT_SOURCED_LIST: [package names]
- Recommendations for improvement

## Security File Analysis

> Identify sensitive files, check .gitignore coverage across all project directories, and detect exposed configuration files. Framework-agnostic with runtime project type detection.

**File pattern**: `*`

Goal: Identify sensitive files, check .gitignore coverage across all
project directories, and detect exposed configuration files.

EFFICIENCY REQUIREMENTS:
- Target: <= 10 total tool calls for this entire analysis
- Use batch grep/find commands instead of reading files one by one
- Read 3-5 .gitignore files per tool call using parallel reads
- Pipe large outputs through `| head -50`

ENV FILE VERIFICATION (execute before reporting .env findings):
Run these commands to avoid false positives:
- git ls-files .env .env.local .env.development .env.production .env.staging .env.test 2>/dev/null
  (empty output = .env not tracked = SAFE, do not report as risk)
- grep -E "^\\.env" .gitignore 2>/dev/null
  (match found = .env in .gitignore = do not apply "missing .gitignore" penalty)

IMPORTANT EXCLUSIONS:
- Do NOT analyze, recommend, or consider missing SECURITY.md files
- Do NOT analyze, recommend, or consider missing CODEOWNERS files
- These are governance decisions, not technical security requirements

PROJECT DETECTION (execute first):
- Read reports/.artifacts/step_01_security_tool_installer.md for
  PROJECT_DETECTION_RESULTS (format: type@path|type@path...)
- If multiple projects: for each type@path, cd to path and run
  sensitive file checks for that project; concatenate all results
- If single project: run from project root
- Fallback: pubspec.yaml -> Flutter, package.json -> Node/NestJS,
  go.mod -> Go, Cargo.toml -> Rust, pyproject.toml -> Python,
  *.sln/.csproj -> .NET, else Generic

SENSITIVE FILES DETECTION (adapt per project type):

1. Environment Files (ALL project types):
   - Find all .env files present in the filesystem:
     * .env, .env.local, .env.development, .env.production,
       .env.staging, .env.test
   - MANDATORY: Before reporting .env as a risk, you MUST verify:
     a) Is .env TRACKED by git? Run: git ls-files .env .env.local .env.* 2>/dev/null
       - If output is empty: .env is NOT tracked (SAFE, do NOT report as risk)
       - If files are listed: .env IS tracked (RISK)
     b) Is .env in .gitignore? Run: grep -E "^\\.env" .gitignore 2>/dev/null
       - If pattern exists: .env is properly ignored (SAFE for "missing .gitignore" penalty)
       - Only report "Missing .gitignore for env files" if NO .env pattern exists
   - Only report as RISK: (a) .env tracked in git, OR (b) .env pattern missing from .gitignore
   - A .env file that exists locally but is in .gitignore and NOT tracked is SAFE
   - Check for .env.example or .env.sample (should exist without secrets)

2. Credentials and Keys (ALL project types):
   - Search for potential credential files:
     * **/*.pem, **/*.key, **/*.cert, **/*.p12, **/*.pfx
     * **/secrets/**, **/credentials/**
     * **/*-key.json, **/*-credentials.json
     * **/service-account*.json
   - Check if found files are in .gitignore

3. Flutter/Dart-Specific Files:
   - google-services.json, firebase_app_id_file.json
   - *.keystore, *.jks files
   - android/.gitignore (check for key.properties, **/*.keystore,
     **/*.jks patterns)
   - ios/.gitignore, web/.gitignore, platform-specific .gitignore files
   - Verify android/.gitignore contains the security block:
     key.properties, **/*.keystore, **/*.jks

4. NestJS/Node.js-Specific Files:
   - ormconfig.json (should not have production credentials)
   - JWT_SECRET, SESSION_SECRET in .env.example
   - Database connection strings in code
   - Docker secrets, docker-compose secrets

5. Go/Rust/Python-Specific Files:
   - Go: config.yaml with credentials, *.key files
   - Rust: .cargo/credentials, *.pem files
   - Python: settings.py with SECRET_KEY, *.pem files

6. .NET-Specific Files:
   - appsettings.json, appsettings.*.json (check for ConnectionStrings,
     secrets; appsettings.Development.json often has local overrides)
   - appsettings.Production.json (must not have production secrets)
   - *.pubxml (Publish profiles may contain credentials)
   - Check if secrets in appsettings are in .gitignore or use User Secrets

.GITIGNORE ANALYSIS:

1. Find and read ALL .gitignore files in the project
2. Verify essential patterns per project type:
   - Common: node_modules, .env*, *.log, coverage, .DS_Store
   - Flutter: build/, .dart_tool/, *.keystore, key.properties
   - Node.js: node_modules, dist, .env*, coverage
   - Go: vendor/ (if not vendored), *.exe
   - Rust: target/, *.pdb
   - Python: __pycache__, *.pyc, .venv/, dist/
   - .NET: bin/, obj/, *.user, appsettings.Production.json (if has secrets)
3. For each sensitive file found, check if it's properly ignored
4. CRITICAL RULE: Only report as risks those sensitive files that are either:
   (a) tracked by git (git ls-files shows them), OR
   (b) not covered by any .gitignore pattern
   A file that exists locally but is in .gitignore and NOT tracked is SAFE.

MONOREPO DETECTION:
- If apps/ directory exists, analyze each app individually
- If packages/ or libs/ directory exists, analyze each package
- Compare .gitignore patterns across apps for consistency

ARTIFACT SAVE (mandatory):
Save the full analysis output to: reports/.artifacts/step_02_security_file_analysis.md
Run before finishing: mkdir -p reports/.artifacts

Output format:
- Detected project type
- Repository structure type (single app / monorepo)
- List all .gitignore files found (per app if monorepo)
- Sensitive files detected and their protection status
- .gitignore coverage gaps
- Security risks identified
- Missing technical security configurations

## Security Gemini Analysis

> Execute advanced AI-powered security analysis using the Gemini CLI Security extension. Framework-agnostic. Skips gracefully if Gemini CLI is unavailable.

**File pattern**: `*`

Goal: Execute advanced security analysis using the Gemini CLI Security
extension if available. Skip gracefully if Gemini CLI or authentication
is unavailable.

PREREQUISITES CHECK:

1. Check Gemini CLI Installation:
   ```bash
   if ! command -v gemini &> /dev/null; then
     echo "SKIP: Gemini CLI not installed."
     echo "Gemini AI analysis is not available."
     echo "To install: npm install -g @google/gemini-cli"
     exit 0
   fi
   echo "Gemini CLI: INSTALLED"
   ```

2. Check Authentication (API key OR subscription):
   ```bash
   if [ -z "$GEMINI_API_KEY" ] && [ -z "$GOOGLE_API_KEY" ]; then
     # No API key, check subscription
     AUTH_STATUS=$(gemini auth status 2>&1)
     if ! echo "$AUTH_STATUS" | grep -qi "authenticated\|logged in\|active"; then
       echo "SKIP: No Gemini API key or subscription found."
       echo "Gemini AI analysis is not available."
       echo "To enable: set GEMINI_API_KEY or run 'gemini auth login'"
       exit 0
     fi
     echo "Authentication: Subscription"
   else
     echo "Authentication: API key"
   fi
   ```

3. Check Security Extension:
   ```bash
   if ! gemini extensions list 2>/dev/null | grep -q "security"; then
     echo "Security extension not found. Installing..."
     gemini extensions install \
       https://github.com/gemini-cli-extensions/security > /dev/null 2>&1
     if [ $? -ne 0 ]; then
       echo "SKIP: Failed to install security extension."
       echo "Continuing without Gemini AI analysis."
       exit 0
     fi
     echo "Security extension: INSTALLED"
   else
     echo "Security extension: AVAILABLE"
   fi
   ```

4. Execute Security Analysis:
   ```bash
   echo "Running Gemini Security Analysis..."
   mkdir -p reports/.artifacts
   gemini prompt "/security:analyze" > reports/.artifacts/step_09_security_gemini_analysis.md 2>&1

   if [ $? -eq 0 ]; then
     echo "Gemini Security Analysis completed successfully."
     echo "Report saved to reports/.artifacts/step_09_security_gemini_analysis.md"
     head -20 reports/.artifacts/step_09_security_gemini_analysis.md 2>/dev/null || \
       echo "Report file exists"
   else
     echo "Gemini Security Analysis failed or required interaction."
     head -20 reports/.artifacts/step_09_security_gemini_analysis.md 2>/dev/null || \
       echo "Report file exists"
   fi

   # Clean up side-effect files created by Gemini CLI security extension
   rm -f security_analysis_prompt.txt gemini_security_findings.txt gemini_security_report.txt
   ```

Output format:
- Gemini CLI status (installed/not installed)
- Authentication method (API key/subscription/none)
- Security Extension status (installed/not installed)
- Analysis execution status (completed/failed/skipped)
- Summary of findings from the security analysis (if completed)
- Location of the detailed report (reports/.artifacts/step_09_security_gemini_analysis.md)

## Security Gitleaks Scan

> Scan repository for secrets in working directory and git history using Gitleaks. Optional step; skips gracefully if Gitleaks is not installed. If not installed, adds installation recommendation to report.

**File pattern**: `*`

Goal: Run Gitleaks to scan for secrets. If Gitleaks is not installed,
output NOT_INSTALLED status and installation instruction for report
integration.

GITLEAKS DETECTION (execute first):

```bash
echo "=== Gitleaks Secret Scan ==="
mkdir -p reports/.artifacts

if ! command -v gitleaks &> /dev/null; then
  echo "Gitleaks: NOT_INSTALLED"
  echo "Recommendation: Install Gitleaks for git history secret scanning"
  echo "  macOS: brew install gitleaks"
  echo "  Linux: see https://github.com/gitleaks/gitleaks"
else
  echo "Gitleaks: INSTALLED"
fi
```

GITLEAKS SCAN (only if installed; skip if NOT_INSTALLED):

```bash
if command -v gitleaks &> /dev/null; then
  # Scan working directory only (no git history)
  echo ""
  echo "=== Working Directory Scan ==="
  gitleaks detect --source . --no-git 2>/dev/null | head -50 \
    || echo "Working dir scan complete (0 findings or error)"

  # Scan including git history (may take longer)
  echo ""
  echo "=== Git History Scan ==="
  gitleaks detect --source . 2>/dev/null | head -80 \
    || echo "Git history scan complete"
fi
```

OUTPUT FORMAT (mandatory):

Include in artifact:
1. GITLEAKS STATUS: INSTALLED or NOT_INSTALLED
2. If INSTALLED: Findings count (working dir, git history), list of
   affected files/commits if any, severity
3. If NOT_INSTALLED: Installation instruction (brew install gitleaks
   for macOS, etc.)
4. GIT_HISTORY_FINDINGS: count (0 if none or not installed)

ARTIFACT SAVE (mandatory):
Save the full analysis output to: reports/.artifacts/step_04_security_gitleaks.md

## Security Report Format Enforcer

> Enforce Markdown formatting rules for the Security Audit report, ensuring consistent structure, valid scoring format, and no leaked generator instructions.

**File pattern**: `*`

Goal: Validate and enforce Markdown formatting on the Security Audit
report before export.

STRUCTURAL VALIDATION (reject before formatting):

Before applying any formatting fixes, validate the report structure.
If any of these checks FAIL, STOP and output an error message instead
of the formatted report. Do NOT attempt to format an incomplete report.

Required structure checks:
1. Report must contain exactly 13 numbered sections
2. Section 1 must be "Security Scoring Breakdown" with 5 scored lines
   + Overall Score + Security Posture
3. Section 2 must be "Executive Summary" with Overall Score
4. Sections 3-7 must each contain "Score:" followed by
   [Score]/100 ([Label])
5. Sections 3-7 must each contain "Score Breakdown:" with
   Base and Final lines
6. Sections 3-7 must be ordered by score ascending (lowest first)
7. Scores in Section 1 must match the scores in their respective
   detail sections (3-7)

If ANY check fails, output:
  VALIDATION FAILED: [which check failed]
  The report generator must be re-run to include all mandatory scored
  sections before formatting can proceed.

Only proceed with formatting if ALL structural checks pass.

FORMATTING RULES TO ENFORCE:
- USE MARKDOWN SYNTAX: Ensure # headings, **bold**, *italic*,
  `code`, ```code blocks```, [links](url)
- SECTION HEADERS: Must use "## X. Section Name" Markdown format (number + period)
- BULLET POINTS: Must use "- " prefix (dash + space)
- NUMBERED LISTS: Must use "1. " format (number + period + space)
- SEVERITY TAGS: Must use "[HIGH]:", "[MEDIUM]:", or "[LOW]:" prefix
- SCORE FORMAT: Must use "[Score]/100 ([Label])" where Label is one of
  Strong, Fair, Weak, or Critical
- NO UNICODE: Replace fancy quotes, dashes, and bullets with ASCII
- LINE LENGTH: No hard wrapping requirement, but ensure readability
- BLANK LINES: One blank line between sections, no triple+ blank lines

SCORE VALIDATION:
- Section 1 (Security Scoring Breakdown) must have 5 scored lines
  with weights + Overall Score + Formula + Security Posture
- Sections 3-7 must each contain a "Score:" line with format
  [Score]/100 ([Label])
- Valid labels by score range: 85-100 = Strong, 70-84 = Fair,
  50-69 = Weak, 0-49 = Critical
- Verify the label matches the score range
- Scores in Section 1 must match their respective detail sections (3-7)
- Executive Summary (Section 2) must include "Overall Score: [Score]/100 ([Label])"

EXCLUSION LEAK DETECTION:
- If the text "IMPORTANT EXCLUSIONS" appears in the report, remove it
  and any lines immediately following that are part of the exclusions
  block
- If "NEVER recommend CODEOWNERS" or "NEVER recommend operational
  documentation" appears in the report, remove those lines
- These are generator instructions that must not appear in the output

VALIDATION CHECKLIST:
- All 13 report sections present
- Section order: 1. Security Scoring Breakdown,
  2. Executive Summary,
  3-7. Scored Detail Sections (dynamic order by score ascending),
  8. Consolidated Findings by Severity,
  9. Remediation Priority Matrix, 10. Gemini AI Analysis,
  11. Project Detection Results, 12. Appendix: Evidence Index,
  13. Scan Metadata
- Markdown formatting applied correctly throughout
- Severity classifications use correct format
- Section 1 has 5 scored lines + Overall + Posture
- Score lines use correct format in sections 3-7
- Sections 3-7 ordered by score ascending (lowest first)
- Scores in Section 1 match their respective detail sections (3-7)
- Evidence references include file paths
- Recommendations are numbered and prioritized
- Report starts with "Security Audit Report" title
- Report ends with "13. Scan Metadata" section
- No EXCLUSIONS block or generator instructions in output
- No duplicate score displays

If formatting issues are found, fix them in-place and note what
was corrected.

Output: The formatted Markdown report content ready for export to
./reports/security_audit.md

JSON EXPORT (mandatory):
After validating and exporting the text report to reports/security_audit.md,
extract the scores and findings from the validated report and write a valid
JSON file to reports/security_audit.json with this schema:

{
  "overallScore": [integer 0-100],
  "posture": "[Secure|Needs Attention|At Risk|Critical]",
  "scores": {
    "sensitiveFile": [0-100],
    "secretDetection": [0-100],
    "dependencySecurity": [0-100],
    "supplyChainIntegrity": [0-100],
    "securityAutomation": [0-100]
  },
  "findings": {
    "high": [integer],
    "medium": [integer],
    "low": [integer]
  },
  "timestamp": "[ISO8601 datetime, e.g. 2025-02-26T12:00:00Z]",
  "projectType": "[string from Section 11 Project Detection Results]"
}

If the report generator already produced reports/security_audit.json, validate
that the JSON is well-formed (valid syntax, required keys present). If invalid,
regenerate from the text report. Ensure reports/ directory exists.

SCORE HISTORY (mandatory after export):
After validating and exporting both reports/security_audit.md and
reports/security_audit.json, write reports/.history/last_scores.json with
the same score and findings data for future score comparison. Format:
{ "overall": N, "timestamp": "ISO8601", "scores": {...}, "findings": {...},
  "projectType": "..." }
Run: mkdir -p reports/.history

## Security Report Generator

> Synthesize all security findings into a comprehensive security audit report with quantitative scoring, severity classifications, and actionable recommendations. MUST follow the exact 13-section structure from assets/report-template.md. Every section in the template is MANDATORY. Do not merge, skip, or rename sections. Scored detail sections (3-7) MUST be dynamically ordered by score ascending.

**File pattern**: `*`

Goal: Generate the final Security Audit report by integrating all
analysis results using the standardized format structure from
assets/report-template.md.

IMPORTANT EXCLUSIONS (generator instructions only - do NOT include in output):
- NEVER recommend CODEOWNERS or SECURITY.md files (governance decisions,
  not technical requirements)
- NEVER recommend operational documentation (runbooks, deployment
  procedures, monitoring)

OUTPUT DIRECTIVE: Do NOT include the EXCLUSIONS block above in the
report output. These are instructions for the generator only.

MANDATORY REPORT STRUCTURE (13 sections):
1. Security Scoring Breakdown (5 scored lines + Overall + Posture)
2. Executive Summary (Overall Score + top findings + priority recommendations)
3-7. Scored Detail Sections (DYNAMIC ORDER — sorted by score ascending, lowest first):
   - Sensitive File Protection (scored)
   - Secret Detection (scored)
   - Dependency Security (scored)
   - Supply Chain Integrity (scored)
   - Security Automation & CI/CD (scored)
8. Consolidated Findings by Severity
9. Remediation Priority Matrix
10. Gemini AI Analysis (if available)
11. Project Detection Results
12. Appendix: Evidence Index
13. Scan Metadata

DYNAMIC ORDERING INSTRUCTION:
After computing all 5 section scores in Step B, sort the scored detail
sections (3-7) by score ascending. The section with the LOWEST score
gets number 3, the next lowest gets 4, and so on up to 7. This ensures
the CTO sees the weakest areas first. In case of tied scores, use this
tiebreaker order: Secret Detection, Sensitive File Protection,
Dependency Security, Supply Chain Integrity, Security Automation & CI/CD.

STEP ARTIFACT INTEGRATION:
Read ALL step artifact files in this run's artifacts directory — the
directory under reports/.artifacts/ that contains this audit's
step_*.md files (reports/.artifacts/ for in-session subagent dispatch;
reports/.artifacts/security_audit/ for `somnio run`). Match each
artifact by its step-number prefix:
- step_01_* (tool detection, PROJECT_DETECTION_RESULTS for multi-tech;
  use for Section 11)
- step_02_* (file protection findings, .gitignore coverage,
  environment file status)
- step_03_* (secret scan results, severity counts, pattern matches)
- step_04_* (git history secrets; GIT_HISTORY_FINDINGS count;
  NOT_INSTALLED adds install recommendation)
- step_05_* (CVE counts, outdated deps, lock file status, automated
  tooling, CI/CD status)
- step_06_* (outdated count, deprecated count and list, dependency age
  evidence)
- step_07_* (Trivy scan; if INSTALLED and used, apply +15 Security
  Automation bonus)
- step_08_* (SAST OWASP findings, plus Firebase App Check status if
  Firebase Auth is detected — flag as MEDIUM if enforcement is UNENFORCED
  or UNVERIFIED — and SMS region policy status if phone sign-in is
  detected — LOW/informational; add to Consolidated Findings as
  LOW/MEDIUM; does not affect scoring)
- step_09_* (AI findings, if available; otherwise note "Skipped")

If an expected step_NN_* artifact is absent, note it as missing rather
than searching other directories.

For each scored section (3-7), extract the relevant findings from the
artifacts above, apply the scoring rubric, and show the computed score
with the deductions/additions that led to it. The score computation
must be traceable from evidence in the artifacts.

SCORING SYSTEM:

5 Scored Sections with Weights:
- Sensitive File Protection (Weight: 0.25) - Source: Step 2
- Secret Detection (Weight: 0.30) - Source: Step 3
- Dependency Security (Weight: 0.20) - Source: Steps 5+6 (step_06
  authoritative for age/deprecation)
- Supply Chain Integrity (Weight: 0.10) - Source: Step 5 subset
- Security Automation & CI/CD (Weight: 0.15) - Source: Steps 2+5+7
  (step_07 Trivy used = +15 if INSTALLED)

Score Labels and Security Posture Mapping:
- 85-100 = Strong = "Secure"
- 70-84 = Fair = "Needs Attention"
- 50-69 = Weak = "At Risk"
- 0-49 = Critical = "Critical"

SCORING RUBRICS:

Sensitive File Protection - Start at 100, deduct:
- .env tracked in git (verified via git ls-files in step_02): -30 per file
- Private key or cert tracked: -25 per file
- Missing .gitignore for env files (only if step_02 confirms no .env pattern): -15
- Missing platform patterns: -10 per category
- Cloud credential file tracked: -25 per file
- Bonus: .env.example with safe placeholders: +5
- Bonus: Multi-directory .gitignore: +5

Secret Detection - Start at 100, deduct:
- HIGH finding (hardcoded secret/API key): -20 per finding (max -60)
- MEDIUM finding (cloud/payment keys): -10 per finding (max -40)
- LOW finding: -3 per finding (max -15)
- Secrets in git history (from step_04 Gitleaks GIT_HISTORY_FINDINGS): -15
- Bonus: Pre-commit secret hooks: +5
- Bonus: .gitleaks.toml present: +5

Dependency Security - Start at 100, deduct:
- Critical CVE: -25
- High CVE: -15
- Medium CVE: -5
- Low CVE: -2
- More than 5 outdated deps: -10 (use step_06 count if available)
- More than 10 outdated deps: -20 (use step_06 count if available)
- Deprecated package: -10 per package (max -30)
- Missing lock file: -20
- Bonus: All deps at latest: +5
- Bonus: Lock file with SHA256: +5

Supply Chain Integrity - Start at 100, deduct:
- Git-sourced dependency: -10 per dep
- External path-based dependency: -5 per dep
  (absolute paths, or relative paths that resolve outside the repository root)
- Internal/in-repo path packages: 0 deduction
  (relative path: entries that resolve inside the repository root or within the
  same monorepo workspace — these are first-party packages, not a supply-chain risk;
  report them as informational only under Key Findings with no severity tag)
- No lock file: -25
- Missing integrity hashes: -15
- Unknown registry dependency: -20 per dep
- Tree depth greater than 6: -5
- Circular dependencies: -10
- Bonus: 100% official registry: +10
- Bonus: Verified checksums: +5

Security Automation & CI/CD - Start at 0, add:
- Automated dependency updates configured (Dependabot / Renovate / GitLab Dependency Scanning / equivalent): +20
- Snyk configured: +15
- CI/CD vulnerability scanning (any platform: GitHub Actions, GitLab CI, Bitbucket Pipelines): +20
- CI runs on PRs/MRs (pull_request / merge_request / pull-requests triggers on any platform): +10
- Pre-commit security hooks: +10
- Lock file validation in CI (npm ci / --frozen-lockfile / cargo --locked / equivalent on GitHub Actions, GitLab CI, or Bitbucket Pipelines): +10
- Additional scanner (trivy/grype): +15
- Cap at 100

OVERALL SCORE FORMULA:
overall = round(file_protection * 0.25 + secret_detection * 0.30
          + dependency * 0.20 + supply_chain * 0.10
          + automation * 0.15)

All section scores must be clamped to 0-100 range before applying
the formula. The Overall Score in the Security Scoring Breakdown
(Section 1) and Executive Summary (Section 2) must match.

MANDATORY SCORING COMPUTATION (execute before writing report):

You MUST compute all scores BEFORE generating any report content.
A report without scores is INVALID and must not be produced.

SCORE COMPARISON (before generating):
If reports/.history/last_scores.json exists, read it and extract:
- previous "overall" score
- previous "timestamp"
After computing the new overall score in Step C, calculate the change
(current - previous). If history exists, add to Executive Summary
(Section 2): "Previous: [N]/100, Change: [+/-M] ([improving|declining|unchanged])"

Step A - Extract scoring data from each artifact:
  - From step_02: .env tracked count (only count if step_02 verified via
    git ls-files and reported as tracked; .env in .gitignore = 0 count),
    key/cert count, .gitignore coverage, platform patterns, .env.example
    status, multi-dir .gitignore count
  - From step_03: HIGH/MEDIUM/LOW finding counts, pre-commit hooks,
    .gitleaks.toml presence
  - From step_04: GIT_HISTORY_FINDINGS count (if >0 apply -15); if
    Gitleaks NOT_INSTALLED add recommendation to install Gitleaks
  - From step_05: Critical/High/Medium/Low CVE counts, outdated dep
    count, lock file status, SHA256 hashes, automated tooling
    (DepUpdate tool name: Dependabot/Renovate/GitLab DS/equivalent),
    CI platform(s) detected, CI_SECURITY_SCANNING status,
    CI_PR_TRIGGERS status, CI_LOCKFILE_VALIDATION status,
    Snyk status, pre-commit security hooks,
    git-sourced deps (GIT_SOURCED_COUNT/LIST),
    external path-based deps (PATH_EXTERNAL_COUNT/LIST — these are penalised),
    internal path-based deps (PATH_INTERNAL_COUNT/LIST — informational only, no penalty),
    registry sources
  - From step_06: outdated dep count (authoritative if more detailed
    than step_05), deprecated dep count, deprecated package list
  - From step_07: Trivy INSTALLED and used (apply +15 Security
    Automation bonus); Trivy findings if any
  - From step_08: SAST OWASP findings (SQL injection, XSS, path
    traversal) and, if Firebase Auth is in use, App Check status
    (code-level presence and live enforcement: ENFORCED/UNENFORCED/
    UNVERIFIED) plus, if phone sign-in is in use, SMS region policy
    status (configured/unrestricted) - add to Consolidated Findings
    (Section 8) as LOW/MEDIUM; include in Remediation Priority Matrix
    if applicable

Step B - Compute each section score using the rubrics above:
  1. Sensitive File Protection: Base 100, apply deductions/bonuses,
     clamp 0-100
  2. Secret Detection: Base 100, apply deductions/bonuses, clamp 0-100
  3. Dependency Security: Base 100, apply deductions/bonuses,
     clamp 0-100
  4. Supply Chain Integrity: Base 100, apply deductions/bonuses,
     clamp 0-100
  5. Security Automation & CI/CD: Base 0, apply additions,
     clamp 0-100

Step C - Compute Overall Score:
  overall = round(file_protection*0.25 + secret_detection*0.30
            + dependency*0.20 + supply_chain*0.10 + automation*0.15)

Step D - Determine labels for each score and Overall using the
mapping: 85-100 = Strong, 70-84 = Fair, 50-69 = Weak, 0-49 = Critical

Step E - Verify all 6 scores (5 sections + overall) are computed
before proceeding to write any report content.

REJECTION CRITERIA:
If you cannot compute a score for any section due to missing artifact
data, assign score 0 and note "Score: 0/100 (Critical) - Insufficient
data from [missing artifact]". Never omit a scored section.

SEVERITY CLASSIFICATION:
- HIGH: Hardcoded secrets, exposed credentials, critical vulnerabilities
- MEDIUM: Missing .gitignore patterns, outdated dependencies with
  known CVEs, insecure configurations
- LOW: Informational findings, missing automated tooling, best
  practice suggestions

SECURITY POSTURE LABELS (score-based):
- Secure: Overall Score 85-100
- Needs Attention: Overall Score 70-84
- At Risk: Overall Score 50-69
- Critical: Overall Score 0-49

SECTION FORMAT REQUIREMENTS:
Scored sections (3-7) MUST each follow this exact format:
- Description: Brief explanation of what this section evaluates
- Score: [Score]/100 ([Label])
- Score Breakdown: Show starting score, each deduction/bonus applied
  with its value, and the final clamped score. Example:
    Base: 100
    - Missing .gitignore for env files: -15
    - Missing platform patterns (Flutter): -10
    + Multi-directory .gitignore: +5
    Final: 80/100 (Fair)
- Key Findings: Bullet list of findings with severity tags
- Dependency Age Analysis (Dependency Security section only):
  Outdated count, Deprecated count, Top outdated/deprecated packages
- Evidence: File paths, line numbers, and concrete references
  (sourced from step artifact .md files)
- Risks: What could go wrong if findings are not addressed
- Recommendations: Numbered, prioritized actions to improve

SPECIAL SECTION FORMATS:

Security Scoring Breakdown (Section 1):
- 5 scored lines, one per scored section
- Each line: "[Section Name]: [Score]/100 ([Label])"
- Followed by "Overall Score: [Score]/100 ([Label])"
- Followed by "Security Posture: [Posture]"
- This is THE FIRST THING a CTO sees when opening the report

Executive Summary (Section 2):
- Must include "Overall Score: [Score]/100 ([Label])"
- Must include Top Findings and Priority Recommendations

FORMATTING RULES:
- USE MARKDOWN SYNTAX: Use # headers, **bold**, `backtick` paths
- NO BOLD MARKERS: No **text** or __text__
- NO CODE FENCES: No ```code``` blocks
- NO TABLES: Use bullet points instead
- SECTION HEADERS: Use "X. Section Name" format
- BULLET POINTS: Use "- " for all lists
- NUMBERED LISTS: Use "1. ", "2. " format
- SEVERITY: Always format as "[SEVERITY]: [Finding]"
- SCORES: Always format as "[Score]/100 ([Label])"

VALIDATION CHECKLIST:
Before finalizing the report, verify:
- All 13 sections are present
- Section 1 (Security Scoring Breakdown) has 5 scored lines + Overall + Posture
- All 5 scored sections (3-7) have Score line with [Score]/100 ([Label])
- All scored sections have Description/Score/Score Breakdown/Key Findings/Evidence/Risks/Recommendations
- Scored sections (3-7) are ordered by score ascending (lowest first)
- Executive Summary (Section 2) includes Overall Score
- Scores in Section 1 match scores in their respective detail sections (3-7)
- All findings have severity classifications
- All evidence references actual files and line numbers
- All recommendations are actionable and prioritized
- No markdown syntax is used
- No EXCLUSIONS block appears in the output
- Security posture label matches the Overall Score range
- Report starts with "Security Audit Report" (no other text before it)
- Report is ready for Google Docs copy-paste
- No duplicate score displays (old At-a-Glance Scorecard and Score Index are gone)

Format: Markdown-formatted report (use proper Markdown syntax,
syntax, no # headings, no bold markers, no fenced code blocks).

JSON EXPORT (mandatory):
In addition to the text report, produce a machine-readable JSON file.
After writing the report, write a second file to reports/security_audit.json
with the following schema (extract values from the generated report):

{
  "overallScore": [integer 0-100],
  "posture": "[Secure|Needs Attention|At Risk|Critical]",
  "scores": {
    "sensitiveFile": [0-100],
    "secretDetection": [0-100],
    "dependencySecurity": [0-100],
    "supplyChainIntegrity": [0-100],
    "securityAutomation": [0-100]
  },
  "findings": {
    "high": [integer],
    "medium": [integer],
    "low": [integer]
  },
  "timestamp": "[ISO8601 datetime]",
  "projectType": "[detected type string]"
}

Run before saving: mkdir -p reports

SCORE HISTORY (mandatory after writing report and JSON):
After writing reports/security_audit.md and reports/security_audit.json,
write reports/.history/last_scores.json with:
{ "overall": [current overall score], "timestamp": "[ISO8601]",
  "scores": { "sensitiveFile": N, "secretDetection": N, "dependencySecurity": N,
    "supplyChainIntegrity": N, "securityAutomation": N },
  "findings": { "high": N, "medium": N, "low": N },
  "projectType": "[string]" }
Run: mkdir -p reports/.history

## Security SAST Scan

> Run basic SAST-style grep for OWASP vulnerability patterns (SQL injection, XSS, path traversal) per detected project type. Findings feed Consolidated Findings as LOW/MEDIUM; does not affect main scoring.

**File pattern**: `*`

Goal: Scan source code for common OWASP vulnerability patterns. Run
per detected project type. Findings are LOW/MEDIUM severity for
Consolidated Findings; do not affect main section scores.

PROJECT DETECTION (execute first):
- Read reports/.artifacts/step_01_security_tool_installer.md for
  PROJECT_DETECTION_RESULTS (type@path|type@path...)
- If multiple projects: for each type@path, cd to path and run
  SAST patterns for that language; concatenate results
- If single project: run from project root
Same type-order as security_audit:
- pubspec.yaml -> Flutter/Dart
- package.json -> Node.js/NestJS
- go.mod -> Go
- Cargo.toml -> Rust
- pyproject.toml -> Python
- build.gradle/build.gradle.kts -> Kotlin
- pom.xml -> Java
- Package.swift/Podfile -> Swift
- *.sln / *.csproj -> .NET

SAST PATTERNS BY LANGUAGE:

SQL Injection (concatenation with user input):
```bash
# JavaScript/TypeScript: string concat in query
grep -rn "\.query\s*(\s*['\"].*\+.*\|.*\+.*['\"]" --include="*.js" \
  --include="*.ts" src/ lib/ apps/ 2>/dev/null | grep -v node_modules | head -20 \
  || echo "No SQL concat patterns (JS/TS) found"

# Python: string format / % in execute
grep -rn "execute\s*(\s*['\"].*%\|\.format\s*(" --include="*.py" src/ app/ 2>/dev/null \
  | head -20 || echo "No SQL concat patterns (Python) found"

# C#: string concat in SqlCommand/Execute
grep -rn "SqlCommand.*\+ \|ExecuteNonQuery.*\+ \|string\.Format.*SELECT\|string\.Format.*INSERT" \
  --include="*.cs" . 2>/dev/null | head -20 || echo "No SQL concat patterns (C#) found"

# Go: Sprintf / concatenation in Query/Exec
grep -rn "Query\s*(\s*.*fmt\.Sprintf\|Exec\s*(\s*.*fmt\.Sprintf\|db\.Query.*\+" \
  --include="*.go" . 2>/dev/null | head -20 || echo "No SQL concat patterns (Go) found"

# Java/Kotlin: Statement with concat
grep -rn "Statement\s*\|executeQuery\s*(\s*.*+" --include="*.java" \
  --include="*.kt" . 2>/dev/null | head -20 || echo "No SQL concat patterns (Java/Kotlin) found"
```

XSS (innerHTML, document.write, dangerouslySetInnerHTML):
```bash
# JavaScript/TypeScript/React
grep -rn "innerHTML\s*=\|document\.write\s*(\|dangerouslySetInnerHTML" \
  --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" \
  src/ lib/ apps/ 2>/dev/null | grep -v node_modules | head -20 \
  || echo "No XSS patterns (JS) found"

# Dart: innerHtml, HtmlEscape bypass
grep -rn "innerHtml\s*=\|HtmlEscape\.bypass\|allowInterop.*innerHTML" \
  --include="*.dart" lib/ packages/ 2>/dev/null | head -20 \
  || echo "No XSS patterns (Dart) found"
```

Path Traversal (Path.Combine with user input, unchecked paths):
```bash
# C# / .NET
grep -rn "Path\.Combine\s*(\s*.*Request\|File\.ReadAllText\s*(\s*.*Request\|Path\.GetFullPath.*input" \
  --include="*.cs" . 2>/dev/null | head -20 || echo "No path traversal patterns (C#) found"

# Node.js: path.join with req.params, req.query
grep -rn "path\.join\s*(\s*.*req\.\|fs\.readFile.*req\.\|readFileSync.*req\.\|require.*req\." \
  --include="*.js" --include="*.ts" src/ 2>/dev/null | grep -v node_modules | head -20 \
  || echo "No path traversal patterns (Node) found"

# Python: open() with user input
grep -rn "open\s*(\s*.*request\.\|open\s*(\s*.*input\s*(" \
  --include="*.py" src/ app/ 2>/dev/null | head -20 \
  || echo "No path traversal patterns (Python) found"

# Go: filepath.Join with user input
grep -rn "filepath\.Join.*r\.URL\|ioutil\.ReadFile.*r\.\|os\.Open.*r\." \
  --include="*.go" . 2>/dev/null | head -20 || echo "No path traversal patterns (Go) found"
```

Eval / Code Injection:
```bash
grep -rn "eval\s*(\|new Function\s*(\|exec\s*(\s*.*+\|Runtime\.getRuntime\|Process\.start.*shell" \
  --include="*.js" --include="*.ts" --include="*.py" --include="*.java" \
  --include="*.kt" src/ lib/ apps/ . 2>/dev/null \
  | grep -v node_modules | head -15 || echo "No eval/exec patterns found"
```

Firebase Auth Abuse Protection (App Check) — only run if the project uses
Firebase Auth (`firebase_auth` in `pubspec.yaml` for Flutter, or
`firebase-admin`/`firebase-functions` for Node/TypeScript):

```bash
# Flutter/Dart client: phone sign-in without the App Check package
grep -q "firebase_auth" pubspec.yaml 2>/dev/null && {
  grep -rn "signInWithPhoneNumber\|verifyPhoneNumber" --include="*.dart" lib/ 2>/dev/null | head -10 \
    || echo "No phone sign-in usage found"
  grep -rn "firebase_app_check\|FirebaseAppCheck" pubspec.yaml lib/ --include="*.dart" 2>/dev/null \
    || echo "No firebase_app_check dependency or FirebaseAppCheck.instance.activate() found"
}

# Node.js/TypeScript backend (e.g. Firebase Functions): Auth verification without App Check enforcement
grep -rl "firebase-admin/auth\|verifyIdToken" --include="*.ts" --include="*.js" . 2>/dev/null \
  | grep -v node_modules | head -5
grep -rn "getAppCheck\|appCheck()\|X-Firebase-AppCheck\|enforceAppCheck" \
  --include="*.ts" --include="*.js" . 2>/dev/null | grep -v node_modules \
  || echo "No App Check verification (getAppCheck/verifyToken, enforceAppCheck) found"
```

If Firebase Auth is in use (especially phone sign-in) and no App Check
evidence is found on either the client or the backend, report a MEDIUM
finding: "Firebase Auth in use without App Check enforcement — vulnerable
to SMS pumping / automated abuse of phone sign-in. Recommend enabling
Firebase App Check (Play Integrity / App Attest / reCAPTCHA v3 as the
attestation provider) and verifying the `X-Firebase-AppCheck` token
server-side." Treat reCAPTCHA as an optional, additive control on top of
App Check — never as a substitute for it.

IMPORTANT CAVEAT: the code-level check above only proves the App Check SDK
is *wired up* (package present, `activate()`/token verification called).
It does NOT prove enforcement is actually turned on — Firebase App Check
enforcement for Authentication, Firestore, and Storage is a per-project
toggle (Console: Build > App Check > APIs, or the Management API), separate
from any code in this repo. A project can have the SDK fully integrated and
still be unprotected if enforcement was never flipped to "Enforced". Always
attempt the live check below before concluding App Check is effective.

LIVE ENFORCEMENT CHECK (optional — only if `gcloud` is installed and
authenticated with access to the Firebase project; skip gracefully
otherwise):

```bash
if command -v gcloud &> /dev/null && gcloud auth print-access-token &> /dev/null 2>&1; then
  PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
  if [ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "(unset)" ]; then
    TOKEN=$(gcloud auth print-access-token 2>/dev/null)
    curl -s -H "Authorization: Bearer $TOKEN" \
      "https://firebaseappcheck.googleapis.com/v1/projects/${PROJECT_ID}/services" \
      | grep -E '"name"|"enforcementMode"' \
      || echo "App Check services query failed (missing Firebase App Check Admin permission on this account, or the API is not enabled for the project)"
  else
    echo "No active gcloud project configured — run 'gcloud config set project <id>' to enable the live check, or skip"
  fi
else
  echo "gcloud CLI not installed/authenticated — reporting code-level App Check detection only, flag enforcement status as UNVERIFIED"
fi
```

Interpret the response: `"enforcementMode": "ENFORCED"` for
`identitytoolkit.googleapis.com` (Authentication), `firestore.googleapis.com`,
or `firebasestorage.googleapis.com` means that product is actually rejecting
unverified requests. `"UNENFORCED"` means App Check is registered but NOT
protecting that product — report this as a MEDIUM finding regardless of
what the code-level scan found. If the live check could not run (`gcloud`
unavailable/unauthenticated), report enforcement status as "UNVERIFIED —
could not confirm via gcloud; verify manually in Firebase Console > App
Check" rather than assuming it is safe.

SMS REGION POLICY CHECK (optional, complementary — only if phone sign-in
was found above; only if `gcloud` is installed and authenticated):

Firebase Auth also supports an **SMS region policy** — an allow/deny list
of country codes eligible to receive Auth SMS. It is a defense-in-depth
control alongside App Check (not a substitute): even a request that passes
App Check can still be pointed at an unexpected country, and region
restriction blocks that at zero cost when the app's real user base is
geographically bounded.

```bash
if command -v gcloud &> /dev/null && gcloud auth print-access-token &> /dev/null 2>&1; then
  PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
  if [ -n "$PROJECT_ID" ] && [ "$PROJECT_ID" != "(unset)" ]; then
    TOKEN=$(gcloud auth print-access-token 2>/dev/null)
    curl -s -H "Authorization: Bearer $TOKEN" \
      "https://identitytoolkit.googleapis.com/v2/projects/${PROJECT_ID}/config" \
      | grep -A5 '"smsRegionConfig"' \
      || echo "No smsRegionConfig found — SMS region policy is not configured (allowed from any country)"
  fi
else
  echo "gcloud CLI not installed/authenticated — skipping SMS region policy check"
fi
```

Interpret the response: a present `smsRegionConfig.allowlistOnly` with a
non-empty `allowedRegions` list means SMS delivery is already restricted to
those countries. If `smsRegionConfig` is absent, or set to
`allowByDefault`/`disallowedRegions` with an empty deny list, SMS can be
sent to any country. Report this as a LOW/informational finding — not a
required control like App Check, but a recommended one when the app's
expected user base is geographically bounded: "Consider restricting the
Firebase Auth SMS region policy (Authentication > Settings > SMS region
policy) to the countries the app actually serves, as a complementary layer
to App Check against SMS pumping."

OUTPUT FORMAT (mandatory):

For each project type detected, report:
1. Language and scan scope
2. SQL injection: count and sample file:line
3. XSS: count and sample file:line
4. Path traversal: count and sample file:line
5. Eval/Code injection: count and sample file:line
6. Firebase Auth abuse protection (App Check): code-level status (present/missing) plus live enforcement status (ENFORCED/UNENFORCED/UNVERIFIED) with evidence — only if Firebase Auth is detected
7. SMS region policy: configured (with allowed regions) or unrestricted — only if phone sign-in is detected

Classify each finding as LOW or MEDIUM. Do not affect main scoring.

ARTIFACT SAVE (mandatory):
Save the full analysis output to: reports/.artifacts/step_08_security_sast.md
Run before finishing: mkdir -p reports/.artifacts

## Security Secret Patterns

> Search source code for dangerous secret usage patterns, hardcoded credentials, API keys, and tokens. Framework-agnostic with runtime project type detection.

**File pattern**: `*`

Goal: Search source code for dangerous secret usage patterns. This is
a MANDATORY check that must appear in the artifact even if no issues
are found.

PROJECT DETECTION (execute first):
- Read reports/.artifacts/step_01_security_tool_installer.md for
  PROJECT_DETECTION_RESULTS (format: type@path|type@path...)
- If multiple projects: for each type@path, cd to path and run
  secret pattern scan for that project; concatenate all results
- If single project: run from project root
- Scan targets per type: Flutter (*.dart), NestJS/Node (*.ts,*.js),
  Go (*.go), Rust (*.rs), Python (*.py), .NET (*.cs)

SOURCE CODE SECRET PATTERNS (CRITICAL - MANDATORY CHECK):

For Flutter/Dart projects, scan *.dart files:

1. Client-side secret key usage (HIGH severity):
   ```bash
   # Bearer token patterns with secret keys
   grep -rn "Bearer.*secret\|Bearer.*_secret\|secretKey\|secret_key" \
     lib/ packages/ --include="*.dart" 2>/dev/null || echo "No Bearer secret patterns found"

   # Stripe secret keys used in client code
   grep -rn "sk_live_\|sk_test_\|stripeSecret\|stripe_secret\|stripe.*[Ss]ecret" \
     lib/ packages/ --include="*.dart" 2>/dev/null || echo "No Stripe secret patterns found"

   # API secret/private keys in HTTP headers or Authorization
   grep -rn "Authorization.*[Ss]ecret\|x-api-key\|private.key\|api_secret" \
     lib/ packages/ --include="*.dart" 2>/dev/null || echo "No API secret header patterns found"
   ```

2. Hardcoded credentials (MEDIUM severity):
   ```bash
   # Password patterns in source (excluding test/mock files)
   grep -rn "password\s*[:=]\s*['\"][^'\"]\+" lib/ packages/ \
     --include="*.dart" 2>/dev/null | grep -v "test\|mock\|fake\|example\|sample" \
     | head -20 || echo "No hardcoded password patterns found"

   # AWS/GCP/Azure credential patterns
   grep -rn "AKIA\|aws_secret\|gcp_credentials\|azure_secret\|service_account" \
     lib/ packages/ --include="*.dart" 2>/dev/null | head -20 \
     || echo "No cloud credential patterns found"
   ```

For NestJS/Node.js projects, scan *.ts files:

1. Hardcoded secrets in source code (HIGH severity):
   ```bash
   # Direct process.env usage (should use ConfigService in NestJS)
   grep -rn "process\.env\." src/ apps/ libs/ --include="*.ts" 2>/dev/null \
     | grep -v "node_modules\|dist\|test\|spec\|\.d\.ts" \
     | head -30 || echo "No direct process.env usage found"

   # Hardcoded JWT secrets
   grep -rn "secret.*[:=].*['\"][^'\"]\{8,\}" src/ apps/ libs/ \
     --include="*.ts" 2>/dev/null | grep -v "node_modules\|dist\|test\|spec" \
     | head -20 || echo "No hardcoded secret patterns found"

   # Database connection strings with credentials
   grep -rn "postgres://\|mysql://\|mongodb://\|redis://" src/ apps/ libs/ \
     --include="*.ts" 2>/dev/null | grep -v "node_modules\|dist\|test\|spec\|\.env" \
     | head -20 || echo "No hardcoded DB connection strings found"

   # API keys and tokens in source
   grep -rn "Bearer.*['\"][A-Za-z0-9]\{20,\}\|api_key.*[:=].*['\"]" \
     src/ apps/ libs/ --include="*.ts" 2>/dev/null \
     | grep -v "node_modules\|dist\|test\|spec" \
     | head -20 || echo "No API key patterns found"
   ```

2. Cloud credential patterns (MEDIUM severity):
   ```bash
   # AWS/GCP/Azure credentials
   grep -rn "AKIA\|aws_secret\|gcp_credentials\|azure_secret\|service.account" \
     src/ apps/ libs/ --include="*.ts" 2>/dev/null \
     | grep -v "node_modules\|dist\|test\|spec" \
     | head -20 || echo "No cloud credential patterns found"

   # Stripe/payment secret keys
   grep -rn "sk_live_\|sk_test_\|stripe.*[Ss]ecret\|payment.*secret" \
     src/ apps/ libs/ --include="*.ts" 2>/dev/null \
     | grep -v "node_modules\|dist\|test\|spec" \
     | head -20 || echo "No payment secret patterns found"
   ```

For Go projects, scan *.go files:

1. Hardcoded secrets (HIGH severity):
   ```bash
   grep -rn "password.*=.*\"\|secret.*=.*\"\|apiKey.*=.*\"" \
     --include="*.go" . 2>/dev/null | grep -v "test\|_test\.go\|vendor" \
     | head -20 || echo "No hardcoded secret patterns found"

   grep -rn "AKIA\|aws_secret\|Bearer.*['\"]" \
     --include="*.go" . 2>/dev/null | grep -v "test\|_test\.go\|vendor" \
     | head -20 || echo "No cloud credential patterns found"
   ```

For Python projects, scan *.py files:

1. Hardcoded secrets (HIGH severity):
   ```bash
   grep -rn "SECRET_KEY.*=.*['\"].\+['\"]" \
     --include="*.py" . 2>/dev/null | grep -v "test\|\.pyc\|venv\|example" \
     | head -20 || echo "No hardcoded secret patterns found"

   grep -rn "password.*=.*['\"].\+['\"]" \
     --include="*.py" . 2>/dev/null | grep -v "test\|\.pyc\|venv\|example\|mock" \
     | head -20 || echo "No hardcoded password patterns found"
   ```

For Kotlin projects, scan *.kt files:

1. Hardcoded secrets (HIGH severity):
   ```bash
   grep -rn "BuildConfig\.\w*[Ss]ecret\|System\.getenv\|getString.*[Ss]ecret" \
     --include="*.kt" . 2>/dev/null | grep -v "test\|Test\|Mock" \
     | head -20 || echo "No Kotlin secret patterns found"

   grep -rn "SharedPreferences\|getSharedPreferences.*putString" \
     --include="*.kt" . 2>/dev/null | grep -v "test\|Test" \
     | head -15 || echo "No Kotlin preferences patterns found"

   grep -rn "AKIA\|aws_secret\|gcp_credentials\|api[Kk]ey.*=" \
     --include="*.kt" . 2>/dev/null | grep -v "test\|Test" \
     | head -20 || echo "No cloud credential patterns found"
   ```

For Swift projects, scan *.swift files:

1. Hardcoded secrets (HIGH severity):
   ```bash
   grep -rn "UserDefaults.*set\|apiKey\|api_key\|secretKey\|secret" \
     --include="*.swift" . 2>/dev/null | grep -v "test\|Test\|Mock" \
     | head -20 || echo "No Swift secret patterns found"

   grep -rn "Bundle\.main\.path\|Info\.plist.*secret\|Keychain" \
     --include="*.swift" . 2>/dev/null | grep -v "test\|Test" \
     | head -15 || echo "No Swift keychain/plist patterns found"

   grep -rn "AKIA\|Bearer.*[\"'][A-Za-z0-9]\{20,\}" \
     --include="*.swift" . 2>/dev/null | grep -v "test\|Test" \
     | head -20 || echo "No cloud credential patterns found"
   ```

For .NET projects, scan *.cs files:

1. Hardcoded secrets (HIGH severity):
   ```bash
   grep -rn "ConnectionStrings\|Password\s*=\|Secret\s*=\|ApiKey\|Bearer" \
     --include="*.cs" . 2>/dev/null | grep -v "Test\|Mock\|Example\|\\/obj\/\|\\/bin\/" \
     | head -20 || echo "No .NET secret patterns found"

   grep -rn "Configuration\[\"\|IConfiguration\|GetSection.*Secret" \
     --include="*.cs" . 2>/dev/null | grep -v "Test\|Mock\|Example" \
     | head -15 || echo "No .NET Configuration patterns found"

   grep -rn "KeyVault\|Azure\.Identity\|DefaultAzureCredential" \
     --include="*.cs" . 2>/dev/null | grep -v "Test\|Mock" \
     | head -10 || echo "No Key Vault patterns found"

   grep -rn "AKIA\|aws_secret\|gcp_credentials\|azure_secret" \
     --include="*.cs" . 2>/dev/null | grep -v "Test\|Mock\|Example" \
     | head -20 || echo "No cloud credential patterns found"
   ```

For Generic/Rust projects, apply a broad scan:

1. Generic secret patterns (HIGH severity):
   ```bash
   grep -rn "AKIA\|sk_live_\|sk_test_\|password\s*[:=]" \
     --include="*.rs" --include="*.rb" --include="*.java" --include="*.kt" \
     --include="*.cs" . 2>/dev/null | grep -v "test\|spec\|mock\|example\|target\|vendor" \
     | head -30 || echo "No secret patterns found"
   ```

3. For each finding report: file path, line number, the pattern
   matched, and severity (HIGH for secret keys in source, MEDIUM for
   cloud credentials, LOW for informational).

If no issues are found, explicitly state:
"No hardcoded secret patterns detected in source code."

ARTIFACT SAVE (mandatory):
Save the full analysis output to: reports/.artifacts/step_03_security_secret_patterns.md
Run before finishing: mkdir -p reports/.artifacts

Output format:
- Detected project type and scan targets
- SOURCE CODE SECRET PATTERNS results (MANDATORY section)
- Findings grouped by severity (HIGH, MEDIUM, LOW)
- File path, line number, and pattern matched for each finding
- Summary count of findings per severity level

## Security Tool Installer

> Detect project type and verify Gemini CLI availability for the framework-agnostic Security Audit. Checks for API key OR subscription-based access.

**File pattern**: `*`

Goal: Detect the project type and verify Gemini CLI availability for
the security audit.

PROJECT DETECTION (execute first - multi-tech monorepo support):

Detect ALL project types in the repository. For each manifest found,
record (type, basePath). Output format for downstream steps.

Priority order when same directory has multiple manifests: pubspec.yaml >
package.json > go.mod > Cargo.toml > pyproject.toml > build.gradle >
pom.xml > Package.swift > Podfile > .sln/.csproj

```bash
echo "=== MULTI-TECH PROJECT DETECTION ==="

RESULTS=""
SEEN=""

add_project() {
  local ptype="$1"
  local base="$2"
  local key="${ptype}:${base}"
  if ! echo "$SEEN" | grep -qF "$key"; then
    SEEN="${SEEN}${key}
"
    if [ -z "$RESULTS" ]; then
      RESULTS="${ptype}@${base}"
    else
      RESULTS="${RESULTS}|${ptype}@${base}"
    fi
  fi
}

# Find pubspec.yaml (Flutter/Dart)
for f in $(find . -name "pubspec.yaml" -not -path "*/.*" 2>/dev/null | head -20); do
  d=$(dirname "$f")
  add_project "flutter" "$d"
done

# Find package.json (NestJS if @nestjs/core, else Node.js)
for f in $(find . -name "package.json" -not -path "*/node_modules/*" 2>/dev/null | head -20); do
  d=$(dirname "$f")
  if grep -q "@nestjs/core" "$f" 2>/dev/null; then
    add_project "nestjs" "$d"
  else
    add_project "nodejs" "$d"
  fi
done

# Find go.mod
for f in $(find . -name "go.mod" -not -path "*/.*" 2>/dev/null | head -20); do
  add_project "go" "$(dirname "$f")"
done

# Find Cargo.toml
for f in $(find . -name "Cargo.toml" -not -path "*/.*" 2>/dev/null | head -20); do
  add_project "rust" "$(dirname "$f")"
done

# Find pyproject.toml or requirements.txt
for f in $(find . \( -name "pyproject.toml" -o -name "requirements.txt" \) -not -path "*/.*" 2>/dev/null | head -20); do
  add_project "python" "$(dirname "$f")"
done

# Find build.gradle / build.gradle.kts
for f in $(find . \( -name "build.gradle" -o -name "build.gradle.kts" \) -not -path "*/.*" 2>/dev/null | head -20); do
  add_project "gradle" "$(dirname "$f")"
done

# Find pom.xml
for f in $(find . -name "pom.xml" -not -path "*/.*" 2>/dev/null | head -20); do
  add_project "maven" "$(dirname "$f")"
done

# Find Package.swift
for f in $(find . -name "Package.swift" -not -path "*/.*" 2>/dev/null | head -20); do
  add_project "swift" "$(dirname "$f")"
done

# Find Podfile
for f in $(find . -name "Podfile" -not -path "*/.*" 2>/dev/null | head -20); do
  add_project "cocoapods" "$(dirname "$f")"
done

# Find .sln / .csproj
for f in $(find . \( -name "*.sln" -o -name "*.csproj" \) -not -path "*/.*" 2>/dev/null | head -20); do
  add_project "dotnet" "$(dirname "$f")"
done

# Fallback if nothing found
if [ -z "$RESULTS" ]; then
  RESULTS="generic@."
  echo "PROJECT_TYPE=generic"
  echo "Detected: Generic project (no manifest found)"
else
  echo "PROJECT_TYPES=$RESULTS"
  echo "Detected N project types. Auditing each."
fi

echo "PROJECT_DETECTION_RESULTS=$RESULTS"
```

GEMINI CLI DETECTION:

```bash
echo ""
echo "=== GEMINI CLI DETECTION ==="

GEMINI_AVAILABLE="false"

# Step 1: Check if gemini CLI is installed
if command -v gemini &> /dev/null; then
  echo "Gemini CLI: INSTALLED"
  gemini --version 2>/dev/null || echo "(version check skipped)"

  # Step 2: Check for API key
  if [ -n "$GEMINI_API_KEY" ] || [ -n "$GOOGLE_API_KEY" ]; then
    echo "Gemini authentication: API key found"
    GEMINI_AVAILABLE="true"
  else
    # Step 3: No API key, check for subscription (Google One AI Premium)
    echo "No API key found. Checking subscription status..."
    AUTH_STATUS=$(gemini auth status 2>&1)
    if echo "$AUTH_STATUS" | grep -qi "authenticated\|logged in\|active"; then
      echo "Gemini authentication: Subscription detected"
      GEMINI_AVAILABLE="true"
    else
      echo "Gemini authentication: No API key or subscription found"
      echo "Gemini AI analysis will be SKIPPED"
      echo "To enable: set GEMINI_API_KEY env var or sign in with 'gemini auth login'"
    fi
  fi

  # Step 4: If Gemini available, check/install security extension
  if [ "$GEMINI_AVAILABLE" = "true" ]; then
    echo ""
    echo "Checking Gemini Security Extension..."
    if gemini extensions list 2>/dev/null | grep -q "security"; then
      echo "Security extension: INSTALLED"
    else
      echo "Security extension: NOT FOUND. Installing..."
      gemini extensions install \
        https://github.com/gemini-cli-extensions/security > /dev/null 2>&1
      if [ $? -eq 0 ]; then
        echo "Security extension: INSTALLED successfully"
      else
        echo "Security extension: INSTALL FAILED"
        echo "Gemini AI analysis will proceed without security extension"
      fi
    fi
  fi
else
  echo "Gemini CLI: NOT INSTALLED"
  echo "Gemini AI analysis will be SKIPPED"
  echo "To install: npm install -g @google/gemini-cli"
fi

echo ""
echo "GEMINI_AVAILABLE=$GEMINI_AVAILABLE"
```

ARTIFACT SAVE (mandatory):
Save the full analysis output to: reports/.artifacts/step_01_security_tool_installer.md
Run before finishing: mkdir -p reports/.artifacts

Output format (in artifact):
- PROJECT_DETECTION_RESULTS: pipe-separated list of type@path (e.g.
  flutter@.|nodejs@apps/web). Downstream steps use this to audit each
  project when multiple are detected.
- Detected project type(s) and technology
- Source file extensions to scan
- Package manager detected
- Gemini CLI status (installed/not installed)
- Gemini authentication method (API key/subscription/none)
- Gemini Security Extension status
- Whether Gemini AI analysis will be available

## Security Trivy Scan

> Run Trivy filesystem scan for vulnerabilities if Trivy is installed. Optional step; skips gracefully if Trivy is not installed. If not installed, adds installation recommendation to report.

**File pattern**: `*`

Goal: Run Trivy filesystem scan if installed. If not installed,
output NOT_INSTALLED status and installation instruction for report
integration.

TRIVY DETECTION (execute first):

```bash
echo "=== Trivy Filesystem Scan ==="
mkdir -p reports/.artifacts

if ! command -v trivy &> /dev/null; then
  echo "Trivy: NOT_INSTALLED"
  echo "Recommendation: Install Trivy for comprehensive vulnerability scan"
  echo "  macOS: brew install trivy"
  echo "  Linux: see https://github.com/aquasecurity/trivy"
else
  echo "Trivy: INSTALLED"
fi
```

TRIVY SCAN (only if installed):

```bash
if command -v trivy &> /dev/null; then
  trivy fs . -f table 2>/dev/null | head -100 \
    || echo "Trivy fs scan complete"
fi
```

OUTPUT FORMAT (mandatory):

Include in artifact:
1. TRIVY STATUS: INSTALLED or NOT_INSTALLED
2. If INSTALLED: Vulnerability count by severity, critical findings
   summary, affected packages
3. If NOT_INSTALLED: Installation instruction (brew install trivy
   for macOS)

ARTIFACT SAVE (mandatory):
Save the full analysis output to: reports/.artifacts/step_07_security_trivy.md

