// Access rules: which apps a member can open inside a tenant, and who counts as an admin.
import { rows, one } from "../db.js";

export const ROLES = ["owner", "admin", "manager", "dispatcher", "driver", "technician", "estimator", "bookkeeper", "sales", "office"];
export const ADMIN_ROLES = ["owner", "admin"];

export const isTenantAdmin = (user, membership) =>
  !!user?.is_platform_admin || !!membership?.roles?.some((r) => ADMIN_ROLES.includes(r));

export function canOpen(membership, tenantApp) {
  if (!membership || membership.status !== "active") return false;
  if (!tenantApp?.enabled || tenantApp.app_status !== "active") return false;
  const ov = membership.app_overrides?.[tenantApp.app_id];
  if (ov === "deny") return false;
  if (ov === "allow") return true;
  if (!tenantApp.allowed_roles?.length) return true;
  return membership.roles.some((r) => tenantApp.allowed_roles.includes(r));
}

const TENANT_APP_SELECT = `
  SELECT ta.tenant_id, ta.app_id, ta.enabled, ta.allowed_roles, ta.label, ta.launch_url AS tenant_launch_url, ta.pinned, ta.sort AS tenant_sort,
         a.name, a.category, a.description, a.icon, a.base_url, a.launch_url, a.initiate_login_uri, a.mobile, a.owner, a.visibility,
         a.status AS app_status, a.sort AS app_sort, a.redirect_uris, a.post_logout_uris, a.backchannel_logout_uri
  FROM tenant_apps ta JOIN apps a ON a.id = ta.app_id`;

export const tenantApps = (tenantId) =>
  rows(`${TENANT_APP_SELECT} WHERE ta.tenant_id = $1 ORDER BY ta.pinned DESC, ta.sort, a.sort, a.name`, [tenantId]);

export const tenantApp = (tenantId, appId) =>
  one(`${TENANT_APP_SELECT} WHERE ta.tenant_id = $1 AND ta.app_id = $2`, [tenantId, appId]);

export const membershipFor = (userId, tenantId) =>
  one(`SELECT * FROM memberships WHERE user_id = $1 AND tenant_id = $2`, [userId, tenantId]);

export const membershipsFor = (userId) =>
  rows(`SELECT m.*, t.slug AS tenant_slug, t.name AS tenant_name, t.status AS tenant_status, t.settings AS tenant_settings
        FROM memberships m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active' ORDER BY m.created_at`, [userId]);

export function tileOf(ta) {
  return {
    id: ta.app_id,
    name: ta.label || ta.name,
    appName: ta.name,
    category: ta.category,
    description: ta.description,
    icon: ta.icon,
    launchUrl: ta.tenant_launch_url || ta.launch_url || ta.base_url,
    pinned: ta.pinned,
    mobile: ta.mobile,
    owner: ta.owner,
  };
}

// Tiles the member can open, in dashboard order.
export async function appsForMember(tenantId, membership) {
  const all = await tenantApps(tenantId);
  return all.filter((ta) => canOpen(membership, ta)).map(tileOf);
}
