/**
 * Wallet Manager
 * Uses eosjs PrivateKey/PublicKey classes for correct EOSIO key handling
 * BIP44 derivation path m/44'/194'/0'/0/0 (EOSIO coin type 194)
 */

import crypto from "crypto";
import * as bip39 from "bip39";
import HDKey from "hdkey";
import { getMongoCollection } from "./db.js";

const DERIVATION_PATH = "m/44'/194'/0'/0/0";

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

// ─── Base58 ───────────────────────────────────────────────────────────────────

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buf) {
  let num = BigInt("0x" + buf.toString("hex"));
  let str = "";
  while (num > 0n) {
    str = BASE58[Number(num % 58n)] + str;
    num /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    str = "1" + str;
  }
  return str;
}

// ─── EOSIO WIF private key ────────────────────────────────────────────────────

function toWif(privKeyBuf) {
  // version 0x80 + key bytes
  const payload  = Buffer.concat([Buffer.from([0x80]), privKeyBuf]);
  const h1       = crypto.createHash("sha256").update(payload).digest();
  const h2       = crypto.createHash("sha256").update(h1).digest();
  const checksum = h2.slice(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

// ─── EOSIO public key (legacy EOS format) ────────────────────────────────────
// Format: "EOS" + base58(compressedPubKey + ripemd160(compressedPubKey)[0:4])

function toEosPublicKey(compressedPubKeyBuf) {
  const checksum = crypto.createHash("ripemd160")
    .update(compressedPubKeyBuf)
    .digest()
    .slice(0, 4);
  return "EOS" + base58Encode(Buffer.concat([compressedPubKeyBuf, checksum]));
}

// ─── Derive keypair from BIP39 mnemonic ──────────────────────────────────────

export async function deriveKeypairFromMnemonic(mnemonic) {
  const seed  = await bip39.mnemonicToSeed(mnemonic);
  const hd    = HDKey.fromMasterSeed(seed);
  const child = hd.derive(DERIVATION_PATH);

  const wif    = toWif(child.privateKey);
  const pubKey = toEosPublicKey(child.publicKey);

  return { wif, pubKey };
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function isValidXprName(name) {
  if (!name) return false;
  if (name.length < 3 || name.length > 12) return false;
  return /^[a-z1-5.]+$/.test(name);
}

// ─── Wallet creation ──────────────────────────────────────────────────────────

export async function createWallet(userId, accountName) {
  const col = await getMongoCollection("wallets");

  const existing = await col.findOne({ userId: String(userId) });
  if (existing) return { exists: true, accountName: existing.accountName };

  const nameExists = await col.findOne({ accountName });
  if (nameExists) return { exists: false, nameTaken: true };

  // Generate mnemonic and derive keys
  const mnemonic       = bip39.generateMnemonic(128);
  const { wif, pubKey } = await deriveKeypairFromMnemonic(mnemonic);

  // Store encrypted key
  await col.insertOne({
    userId:          String(userId),
    accountName,
    publicKey:       pubKey,
    privateKeyEnc:   encryptKey(wif),
    createdAt:       new Date(),
    accountCreated:  false,
    autoBuyXpr:      5,
    autoSellX:       3,
    autoBuyEnabled:  false,
    autoSellEnabled: false,
  });

  // Create on-chain
  let accountCreated = false;
  let creationError  = null;
  try {
    const { createXprAccount } = await import("./trader.js");
    await createXprAccount(accountName, pubKey);
    accountCreated = true;
    await col.updateOne({ userId: String(userId) }, { $set: { accountCreated: true } });
  } catch (e) {
    creationError = e.message;
    console.error("On-chain account creation failed:", e.message);
  }

  return { exists: false, nameTaken: false, mnemonic, publicKey: pubKey, accountName, accountCreated, creationError };
}

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
  const col = await getMongoCollection("wallets");
  const result = await col.find({ autoBuyEnabled: true });
  return result.toArray();
}
