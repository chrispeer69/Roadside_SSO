import * as OTPAuth from "otpauth";

export const newMfaSecret = () => new OTPAuth.Secret({ size: 20 }).base32;

export function otpauthUrl(secret, email) {
  return new OTPAuth.TOTP({ issuer: "Roadside SSO", label: email, secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).toString();
}

export function verifyMfaCode(secret, code) {
  if (!secret || !/^\d{6}$/.test(String(code ?? "").trim())) return false;
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 });
  return totp.validate({ token: String(code).trim(), window: 1 }) !== null;
}
