// RS256 signing keys. Stored in Postgres so every instance signs with the same key.
import { generateKeyPair, exportJWK, importJWK, SignJWT, jwtVerify, createLocalJWKSet } from "jose";
import { randomToken } from "./crypto.js";
import { one, rows, query } from "../db.js";
import { config } from "../config.js";

let current = null;   // { kid, privateKey }
let jwks = { keys: [] };
let localSet = null;

export async function initKeys() {
  let active = await one(`SELECT * FROM signing_keys WHERE active = true ORDER BY created_at DESC LIMIT 1`);
  if (!active) {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
    const kid = randomToken(12);
    const priv = { ...(await exportJWK(privateKey)), kid, alg: "RS256", use: "sig" };
    const pub = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
    await query(`INSERT INTO signing_keys (kid, private_jwk, public_jwk) VALUES ($1, $2, $3)`, [kid, priv, pub]);
    active = { kid, private_jwk: priv, public_jwk: pub };
    console.log(`[keys] generated signing key ${kid}`);
  }
  current = { kid: active.kid, privateKey: await importJWK(active.private_jwk, "RS256") };
  const all = await rows(`SELECT public_jwk FROM signing_keys ORDER BY created_at DESC`);
  jwks = { keys: all.map((r) => r.public_jwk) };
  localSet = createLocalJWKSet(jwks);
}

export const getJwks = () => jwks;

export async function signJwt(payload, { audience, subject, expiresIn }) {
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: current.kid, typ: "JWT" })
    .setIssuer(config.publicUrl)
    .setIssuedAt();
  if (audience) jwt.setAudience(audience);
  if (subject) jwt.setSubject(subject);
  if (expiresIn) jwt.setExpirationTime(expiresIn);
  return jwt.sign(current.privateKey);
}

export async function verifyJwt(token, opts = {}) {
  const { payload } = await jwtVerify(token, localSet, { issuer: config.publicUrl, ...opts });
  return payload;
}
