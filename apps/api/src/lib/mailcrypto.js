// AES-256-GCM for mailbox passwords at rest. Key: MAIL_ENCRYPTION_KEY (any long string), else derived from SESSION_SECRET.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

const key = createHash("sha256").update(process.env.MAIL_ENCRYPTION_KEY || `mail:${config.sessionSecret}`, "utf8").digest();

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decryptSecret(blob) {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
