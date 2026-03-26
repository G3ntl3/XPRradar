/**
 * Wallet Manager — Import Mode
 * Accepts both WIF (5K...) and PVT_K1_... private key formats.
 * eosjs handles both natively via PrivateKey.fromString().
 *
 * KEY VALIDATION PHILOSOPHY:
 * We do only a minimal format check (starts with 5 or PVT_K1_) to catch
 * obvious mistakes like pasting a public key or random text.
 * The REAL validation is done by eosjs when it derives the public key —
 * if the key is invalid, eosjs will throw and we catch it gracefully.
 *
 * KEY VERIFICATION FIX:
 * EOS-prefixed keys (stored on-chain) use a different checksum than PUB_K1_.
 * We derive BOTH formats and compare against either.
 */

import crypto from "crypto";
import { getMongoCollection } from "./db.js";

// ─── Encryption ───────────────────────────────────────────────────────────────

const ENC_KEY = () => {
  const k = process.env.WALLET_ENCRYPT_KEY || "change-me-32-char-key-xprradar!!";
  return crypto.scryptSync(k, "xpr-radar-salt", 32);
};

export function encryptKey(text) {
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENC_KEY(), iv);
  const enc    = Buffer.concat([cipher.update(text), cipher.final()]);
  return iv.toString("hex") + ":" + enc.toString("hex");
}

export function decryptKey(text) {
  const [ivHex, encHex] = text.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc", ENC_KEY(), Buffer.from(ivHex, "hex")
  );
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, "hex")),
    decipher.final(),
  ]).toString();
}

// ─── Validate private key format ──────────────────────────────────────────────
// RELAXED — only checks the prefix/rough shape to catch obvious mistakes.
// eosjs does the real cryptographic validation during key derivation.
// We accept:
//   WIF:      starts with 5, 51 chars, base58
//   PVT_K1_:  modern Antelope format from WebAuth, any length after prefix

export function isValidPrivateKey(key) {
  if (!key || typeof key !== "string") return false;
  const k = key.trim();
  if (k.length < 10) return false;

  // WIF format — starts with 5 (relaxed: any base58 chars, ~51 long)
  if (/^5[1-9A-HJ-NP-Za-km-z]{40,}$/.test(k)) return true;

  // Modern Antelope / WebAuth format
  if (k.startsWith("PVT_K1_") && k.length > 20) return true;

  return false;
}

// ─── Derive public key — both formats ────────────────────────────────────────
// Returns pubKeyK1 (PUB_K1_...) and pubKeyEOS (EOS...) from a private key.
// toLegacyString() produces the EOS-prefix format with the correct checksum
// that matches what the chain stores.

export async function getPublicKeyFromPrivate(privateKey) {
  const { PrivateKey } = await import("eosjs/dist/eosjs-jssig.js");
  const priv = PrivateKey.fromString(privateKey.trim());
  const pub  = priv.getPublicKey();
  return {
    pubKeyK1:  pub.toString(),        // PUB_K1_...
    pubKeyEOS: pub.toLegacyString(),  // EOS... ← correct checksum for chain comparison
  };
}

// ─── Verify key matches account on-chain ─────────────────────────────────────

export async function verifyKeyMatchesAccount(privateKey, accountName) {
  try {
    const { pubKeyK1, pubKeyEOS } = await getPublicKeyFromPrivate(privateKey);

    console.log("Derived PUB_K1_:", pubKeyK1);
    console.log("Derived EOS:    ", pubKeyEOS);

    // Try multiple endpoints in case primary is down
    const RPC_ENDPOINTS = [
      "https://api.protonnz.com",
      "https://mainnet-api.xprdata.org",
      "https://proton.eosusa.io",
      "https://proton.greymass.com",
    ];

    let data = null;
    for (const base of RPC_ENDPOINTS) {
      try {
        const res = await fetch(`${base}/v1/chain/get_account`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ account_name: accountName }),
          signal:  AbortSignal.timeout(8000),
        });
        if (res.ok) { data = await res.json(); break; }
      } catch (e) {
        console.warn(`get_account failed on ${base}: ${e.message}`);
      }
    }

    if (!data) {
      return { valid: false, error: `Account "${accountName}" not found on XPR Network` };
    }

    // Collect all keys from all permissions
    const chainKeys = [];
    for (const perm of data.permissions ?? []) {
      for (const k of perm.required_auth?.keys ?? []) {
        chainKeys.push(k.key);
      }
    }

    console.log("Chain keys:", chainKeys);

    // Compare full strings against BOTH derived formats
    const match = chainKeys.some(chainKey =>
      chainKey === pubKeyEOS || chainKey === pubKeyK1
    );

    if (!match) {
      return {
        valid:  false,
        error:  `Private key does not match any key on account "${accountName}".\n` +
                `Derived: ${pubKeyEOS}\nChain keys: ${chainKeys.join(", ")}`,
        chainKeys,
      };
    }

    return { valid: true, pubKey: pubKeyEOS, accountName };

  } catch (e) {
    return { valid: false, error: `Verification error: ${e.message}` };
  }
}

// ─── Find account by key ──────────────────────────────────────────────────────

export async function findAccountByKey(privateKey) {
  try {
    const { pubKeyK1, pubKeyEOS } = await getPublicKeyFromPrivate(privateKey);

    const RPC_ENDPOINTS = [
      "https://api.protonnz.com",
      "https://mainnet-api.xprdata.org",
      "https://proton.eosusa.io",
      "https://proton.greymass.com",
    ];

    for (const pubKey of [pubKeyEOS, pubKeyK1]) {
      for (const base of RPC_ENDPOINTS) {
        try {
          const res = await fetch(`${base}/v1/chain/get_accounts_by_authorizers`, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ accounts: [], keys: [pubKey] }),
            signal:  AbortSignal.timeout(8000),
          });
          if (!res.ok) continue;
          const data = await res.json();
          if (data.accounts?.length > 0) return data.accounts[0].account_name;
        } catch (e) {
          console.warn(`get_accounts_by_authorizers failed on ${base}: ${e.message}`);
        }
      }
    }

    return null;
  } catch (e) {
    console.error("findAccountByKey error:", e.message);
    return null;
  }
}

// ─── Import wallet ────────────────────────────────────────────────────────────

export async function importWallet(userId, privateKey, accountName) {
  const col = await getMongoCollection("wallets");

  const existing = await col.findOne({ userId: String(userId) });
  if (existing) return { error: "already_exists", accountName: existing.accountName };

  const verification = await verifyKeyMatchesAccount(privateKey, accountName);
  if (!verification.valid) return { error: "key_mismatch", message: verification.error };

  await col.insertOne({
    userId:          String(userId),
    accountName,
    publicKey:       verification.pubKey,
    privateKeyEnc:   encryptKey(privateKey.trim()),
    importedAt:      new Date(),
    accountCreated:  true,
    autoBuyXpr:      5,
    autoSellX:       3,
    autoSellSL:      0.6, // Default -40% drop
    autoBuyEnabled:  false,
    autoSellEnabled: false,
  });

  return { success: true, accountName, pubKey: verification.pubKey };
}

// ─── Remove wallet ────────────────────────────────────────────────────────────

export async function removeWallet(userId) {
  const col = await getMongoCollection("wallets");
  await col.deleteOne({ userId: String(userId) });
}

// ─── Standard getters ─────────────────────────────────────────────────────────

export async function getWallet(userId) {
  const col = await getMongoCollection("wallets");
  return col.findOne({ userId: String(userId) });
}

export async function getPrivateKey(userId) {
  const wallet = await getWallet(userId);
  if (!wallet) return null;
  return decryptKey(wallet.privateKeyEnc);
}

export async function updateWalletSettings(userId, settings) {
  const col = await getMongoCollection("wallets");
  await col.updateOne({ userId: String(userId) }, { $set: settings });
}

export async function getAllActiveAutobuyers() {
  const col    = await getMongoCollection("wallets");
  const result = await col.find({ autoBuyEnabled: true });
  return result.toArray();
}