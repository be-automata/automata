/**
 * The member roles that may change an org's own settings. Kept in a module
 * with no imports so the auth layer (lib/auth-server.ts) can use it without
 * loading lib/org-role.ts and its model import: loading that from a test
 * setup file cached the real getMembership before a test could mock it.
 */
export const ORG_ADMIN_ROLES = new Set(["owner", "admin"]);
