import { createHash, randomBytes, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";

export const sha256 = (s) => createHash("sha256").update(s).digest("base64url");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const hashPassword = (p) => bcrypt.hash(p, 12);
export const verifyPassword = (p, h) => (h ? bcrypt.compare(p, h) : Promise.resolve(false));

const WORDS = ["Tow", "Hook", "Wrench", "Flat", "Crew", "Road", "Winch", "Fleet", "Beacon", "Lift", "Chain", "Route", "Dolly", "Strap", "Truck", "Ridge"];
// Readable one-time password an admin can text to a driver. Example: Winch-4831-Route
export function tempPassword() {
  const w = () => WORDS[randomInt(WORDS.length)];
  return `${w()}-${randomInt(1000, 9999)}-${w()}`;
}

export function passwordProblem(p) {
  if (typeof p !== "string" || p.length < 10) return "Password must be at least 10 characters.";
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return "Password must include letters and numbers.";
  return null;
}

export const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
