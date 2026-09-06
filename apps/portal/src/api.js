// Thin JSON client for the portal API. Same-origin cookies carry the session.
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : { "x-requested-with": "XMLHttpRequest" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? `Request failed (${res.status})`);
  return data;
}

export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: "POST", body });
export const put = (p, body = {}) => api(p, { method: "PUT", body });
export const patch = (p, body = {}) => api(p, { method: "PATCH", body });
export const del = (p) => api(p, { method: "DELETE" });
