/**
 * How an organization is told apart at a glance: a stable hue (from a fixed
 * palette that reads on the warm paper ground in light and dark) and initials.
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
  { bg: "#2e7d32", fg: "#ffffff", darkBg: "#4caf50", darkFg: "#0a1f0c" },
  { bg: "#9a6410", fg: "#ffffff", darkBg: "#e2aa4e", darkFg: "#2d2517" },
  { bg: "#1f5f8b", fg: "#ffffff", darkBg: "#6fa8d6", darkFg: "#0d2333" },
  { bg: "#8e3b46", fg: "#ffffff", darkBg: "#e08a96", darkFg: "#33141a" },
  { bg: "#56687a", fg: "#ffffff", darkBg: "#a3b4c4", darkFg: "#1c242c" },
  { bg: "#6b5b1e", fg: "#ffffff", darkBg: "#cdb85e", darkFg: "#262009" },
  { bg: "#2f6f6a", fg: "#ffffff", darkBg: "#6cc0b8", darkFg: "#0e2725" },
  { bg: "#7a4a2a", fg: "#ffffff", darkBg: "#d39a72", darkFg: "#2b190d" },
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
 * Backfilled personal orgs carry a `personal-<userId>` slug
 * (packages/shared/scripts/backfill-organizations.ts); no column marks them yet.
 */
export function isPersonalOrganizationSlug(slug: string | null): boolean {
  return !!slug && slug.startsWith("personal-");
}
