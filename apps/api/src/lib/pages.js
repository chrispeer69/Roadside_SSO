// Minimal server-rendered pages for OIDC error states (styled to match the portal).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function errorPage(title, message, { link, label } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Roadside SSO</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6f9;font-family:"IBM Plex Sans","Segoe UI",Arial,sans-serif;color:#1c2b45}
.card{background:#fff;border:1px solid #d9e0ea;border-top:3px solid #16417c;padding:28px 32px;max-width:440px;width:calc(100% - 32px)}
.brand{font-size:11px;letter-spacing:.14em;color:#16417c;font-weight:600;margin-bottom:14px}
h1{font-size:18px;font-weight:600;color:#0f2f5f;margin:0 0 8px}
p{margin:0;font-size:13px;line-height:1.5;color:#3d4d68}
a{display:inline-block;margin-top:18px;padding:7px 14px;background:#dfeaf8;border:1px solid #b9cfec;color:#0f2f5f;text-decoration:none;font-size:12px;font-weight:500}
</style></head><body><div class="card"><div class="brand">ROADSIDE SSO</div><h1>${esc(title)}</h1><p>${esc(message)}</p>
${link ? `<a href="${esc(link)}">${esc(label ?? "Continue")}</a>` : ""}</div></body></html>`;
}
