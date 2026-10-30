import { createPublicKey, verify, type KeyObject } from "node:crypto";

// DER prefix for an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const keyCache = new Map<string, KeyObject>();

function publicKey(hex: string): KeyObject {
  let key = keyCache.get(hex);
  if (!key) {
    const raw = Buffer.from(hex, "hex");
    if (raw.length !== 32) throw new Error("DISCORD_PUBLIC_KEY must be 32 bytes of hex");
    key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    keyCache.set(hex, key);
  }
  return key;
}

/** Checks Discord's Ed25519 signature over timestamp + raw body. */
export function verifyDiscordSignature(
  rawBody: string,
  signatureHex: string | null,
  timestamp: string | null,
  publicKeyHex: string,
): boolean {
  if (!signatureHex || !timestamp || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
  try {
    return verify(null, Buffer.from(timestamp + rawBody), publicKey(publicKeyHex), Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}
