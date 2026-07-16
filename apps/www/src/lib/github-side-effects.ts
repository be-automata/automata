import { env } from "@terragon/env/apps-www";
import { InstallationMode } from "@terragon/shared/model/github-installation";

/**
 * Deployment-level kill-switch for ALL GitHub side effects (pilot).
 *
 * `GITHUB_SIDE_EFFECTS_ENABLED` defaults TRUE (back-compat: existing prod /
 * self-host are unaffected). When FALSE — set on the pilot Workers deployment
 * until the pilot binding is verified in shadow — every GitHub-processing path
 * is forced into shadow behavior regardless of the per-installation mode. This
 * closes the id-capture window: between wiring the pilot webhook and binding the
 * installation, an event from a resolvable sender would otherwise resolve to
 * 'active' (the migration-safe no-row default) and act on a live customer PR.
 *
 * Per-installation mode governs only while the switch is ON.
 */
export function githubSideEffectsEnabled(): boolean {
  return env.GITHUB_SIDE_EFFECTS_ENABLED;
}

/**
 * The effective shadow flag for a GitHub-processing path: true (suppress boot +
 * side effects) when the global switch is off, otherwise the installation's own
 * mode decides. Call this at the single point where each path derives `shadow`.
 */
export function effectiveShadow(installationMode: InstallationMode): boolean {
  if (!githubSideEffectsEnabled()) {
    return true;
  }
  return installationMode === "shadow";
}
