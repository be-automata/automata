# #724 evidence (2026-11-20)

## `verify.sh` (offline, `--network none`, uid 10001)

| Image                                   | Exit            | CA/Dart lines                                                                                                                                                                                                       |
| :-------------------------------------- | :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `automata-cell:724` (this branch)       | 0, 46 checks ok | `ca-store-owner`, `ca-store-rest-root`, `ca-store-no-hooks`, `dart-trust-control` (fails `CERTIFICATE_VERIFY_FAILED`), `dart-trust-install`, `dart-trust`, `dart-trust-rotation`, `dart-trust-rotation-old`: all ok |
| `automata-cell:fix716` (before the fix) | 1               | `FAIL ca-store-owner`; `FAIL dart-trust-install`: `cp: cannot create regular file '/usr/local/share/ca-certificates/opensandbox-mitmproxy-ca.crt': Permission denied`                                               |

The control case confirms the probe is real: `dart-trust-control` passes on both images.

## Cell integration test (IT-E1, real OpenSandbox 1.2.1, throwaway amd64 host)

- **Host:** Hetzner cpx32 (x86) in fsn1, created for this run.
- **Image:** `automata-cell:724`, built on that host with the `cell-image-build` action's recipe, then loaded into the integration test's container.
- **At `e77acc64`:** 8/8 cases passed. **At `fad68bf1`** (case (g) with the positive deny marker): 8/8 passed in 50.4 s.

Case (g) probes, fixed image:

| Probe                                                          | Exit | Output                                                                                  |
| :------------------------------------------------------------- | :--- | :-------------------------------------------------------------------------------------- |
| `dart create … && dart pub add path:1.9.1 && dart pub get`     | 0    | `Got dependencies!`                                                                     |
| `flutter create --no-pub --platforms=web … && flutter pub get` | 0    | `Changed 27 dependencies!`                                                              |
| `npm view left-pad version`                                    | 0    | `1.3.0`                                                                                 |
| `git ls-remote https://github.com/git/git HEAD`                | 0    | a HEAD sha                                                                              |
| `curl https://pub.dev`                                         | 0    |                                                                                         |
| `pip download --no-deps six`                                   | 0    | `Successfully downloaded six`                                                           |
| Dart fetch of `https://example.org/` (not on the allowlist)    | 255  | `SocketException: Failed host lookup: 'example.org'`, with no handshake or verify error |

Negative control: the same case (g) on the published image `ghcr.io/be-automata/automata-cell@sha256:4c7228d0…` (before this fix).

- dart exits 65 and flutter exits 69, both with `Got TLS error trying to find package … at https://pub.dev.`
- npm, git and curl exit 0.
- pip exits 127 (`pip: command not found`): that image predates the #716 fix, so it has no pip. This failure is not TLS.
- `example.org` is denied at DNS, the same as on the fixed image.

## Still open after merge (production)

- **AC-3:** the `deny` row in the worker's `egress_events`.
- **AC-8:** re-run #719 AC-1 in production on the published digest and post the result on #719.
