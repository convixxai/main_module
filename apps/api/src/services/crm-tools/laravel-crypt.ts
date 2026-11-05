// ============================================================
// Decrypts values written by the SaaS (Laravel `encrypted` cast), e.g.
// crm_tools.secret. Laravel's Encrypter (AES-256-CBC, config/app.php cipher):
//   base64( JSON {iv, value, mac, tag} ), mac = HMAC-SHA256(iv + value, key)
// The key is the SaaS APP_KEY ("base64:..."), provided to the engine as
// SAAS_APP_KEY. Without it, custom tools that need a secret are skipped
// (never called unauthenticated).
// ============================================================

import crypto from "crypto";

function appKey(): Buffer | null {
  const raw = (process.env.SAAS_APP_KEY ?? "").trim();
  if (!raw) return null;
  const key = raw.startsWith("base64:") ? Buffer.from(raw.slice(7), "base64") : Buffer.from(raw, "utf8");
  return key.length === 32 ? key : null;
}

export function hasSaasAppKey(): boolean {
  return appKey() !== null;
}

/** Returns the plaintext, or null when the key is missing or the payload is invalid/tampered. */
export function decryptLaravelString(payload: string | null | undefined): string | null {
  const key = appKey();
  if (!key || !payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
      iv: string;
      value: string;
      mac: string;
    };
    const expected = crypto.createHmac("sha256", key).update(json.iv + json.value).digest("hex");
    if (
      !json.mac ||
      expected.length !== json.mac.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(json.mac))
    ) {
      return null;
    }
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, Buffer.from(json.iv, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(json.value, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Test helper: same format Laravel's encryptString produces. */
export function encryptLaravelString(plaintext: string): string | null {
  const key = appKey();
  if (!key) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const value = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
  const ivB64 = iv.toString("base64");
  const mac = crypto.createHmac("sha256", key).update(ivB64 + value).digest("hex");
  return Buffer.from(JSON.stringify({ iv: ivB64, value, mac, tag: "" })).toString("base64");
}
