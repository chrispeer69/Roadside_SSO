// Claims placed in access tokens, id tokens and userinfo for connected apps.
import { appsForMember } from "./access.js";

export async function buildClaims({ user, tenant, membership }) {
  const apps = await appsForMember(tenant.id, membership);
  return {
    email: user.email,
    email_verified: true,
    name: user.name,
    phone_number: user.phone ?? undefined,
    org_id: tenant.id,
    org_slug: tenant.slug,
    org_name: tenant.name,
    roles: membership.roles,
    locations: membership.locations,
    title: membership.title ?? undefined,
    apps: apps.map((a) => a.id),
    platform_admin: user.is_platform_admin || undefined,
  };
}
