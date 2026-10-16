/**
 * How an organization is told apart at a glance: a stable hue and initials.
 * The palette skips red and green so an avatar never reads as a run state
 * (DESIGN.md: color means a state or a scope).
 * The org NAME stays the primary cue; the hue only makes a switch visible.
 */
export interface OrgHue {
  /** Avatar background and text, light mode. */
  bg: string;
  fg: string;
  /** Avatar background and text, dark mode. */
  darkBg: string;
  darkFg: string;
}

export const ORG_HUES: readonly OrgHue[] = [
  { bg: "#2f4db0", fg: "#ffffff", darkBg: "#8ea6ff", darkFg: "#121715" },
  { bg: "#7a3e9d", fg: "#ffffff", darkBg: "#c79aee", darkFg: "#121715" },
  { bg: "#3b5a7a", fg: "#ffffff", darkBg: "#9fb8d4", darkFg: "#121715" },
  { bg: "#7a5a1e", fg: "#ffffff", darkBg: "#d6b56a", darkFg: "#121715" },
  { bg: "#4f5d6b", fg: "#ffffff", darkBg: "#aab6c2", darkFg: "#121715" },
  { bg: "#8a3d6c", fg: "#ffffff", darkBg: "#e09ac4", darkFg: "#121715" },
  { bg: "#1f4f8b", fg: "#ffffff", darkBg: "#7fb0e6", darkFg: "#121715" },
  { bg: "#6e4a33", fg: "#ffffff", darkBg: "#cf9e7c", darkFg: "#121715" },
];

/** FNV-1a over the id: stable across renders, servers and deploys. */
export function orgHueIndex(organizationId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < organizationId.length; i++) {
    hash ^= organizationId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % ORG_HUES.length;
}

export function orgHue(organizationId: string): OrgHue {
  // The modulo keeps the index in range.
  return ORG_HUES[orgHueIndex(organizationId)]!;
}

/** Up to two initials from the org name ("Automata AI" → "AA"). */
export function orgInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  const initials =
    words.length === 1
      ? words[0]!.slice(0, 2)
      : `${words[0]![0]}${words[1]![0]}`;
  return initials.toUpperCase();
}

/**
 * organization.is_personal — the only source. The legacy `personal-<userId>`
 * slug convention is NOT consulted: every row is backfilled, and any user can
 * create a team org whose slug starts with `personal-`.
 */
export function isPersonalOrganization(org: {
  isPersonal?: boolean | null;
}): boolean {
  return org.isPersonal === true;
}
