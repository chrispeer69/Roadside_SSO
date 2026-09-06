// Normalizes Roadside SSO token claims into a plain user object.
export function parseClaims(token = {}) {
  return {
    sub: token.sub,
    email: token.email,
    name: token.name ?? "",
    phone: token.phone_number ?? null,
    orgId: token.org_id,
    orgSlug: token.org_slug,
    orgName: token.org_name,
    roles: token.roles ?? [],
    locations: token.locations ?? [],
    apps: token.apps ?? [],
    title: token.title ?? null,
    platformAdmin: !!token.platform_admin,
    sid: token.sid,
    exp: token.exp,
  };
}
export const hasApp = (u, id) => !!u?.apps?.includes(id);
export const hasRole = (u, ...roles) => roles.some((r) => u?.roles?.includes(r));
export const isAdmin = (u) => hasRole(u, "owner", "admin") || !!u?.platformAdmin;
