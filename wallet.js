/**
 * Wallet Manager
 * Generates BIP39 seed phrases, derives XPR keypairs,
 * stores AES-256 encrypted private keys in MongoDB per user.
 *
 * Required env vars:
 *   WALLET_ENCRYPT_KEY  — strong random string, never change it
 *   MONGODB_URI         — MongoDB Atlas connection string
 */

import crypto from "crypto";
import * as bip39 from "bip39";
import { getMongoCollection } from "./db.js";

// ─── Encryption ───────────────────────────────────────────────────────────────

const ENC_KEY = () => {
  const k = process.env.WALLET_ENCRYPT_KEY || "change-me-to-32-char-random-key!";
  return crypto.scryptSync(k, "xpr-radar-salt", 32);
};

export function encryptKey(text) {
  const iv      = crypto.randomBytes(16);
  const cipher  = crypto.createCipheriv("aes-256-cbc", ENC_KEY(), iv);
  const enc     = Buffer.concat([cipher.update(text), cipher.final()]);
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

// ─── Key derivation from BIP39 seed ──────────────────────────────────────────
// EOSIO uses secp256k1 — we derive a 32-byte private key from the seed
// then convert to WIF format for eosjs

function seedToEosPrivateKey(seedBuffer) {
  // Use first 32 bytes of seed as raw private key
  const rawKey  = seedBuffer.slice(0, 32);
  // WIF encoding for EOSIO: version byte 0x80 + key + checksum
  const version = Buffer.from([0x80]);
  const payload = Buffer.concat([version, rawKey]);
  // Double SHA256 checksum
  const h1      = crypto.createHash("sha256").update(payload).digest();
  const h2      = crypto.createHash("sha256").update(h1).digest();
  const checksum = h2.slice(0, 4);
  const wif     = Buffer.concat([payload, checksum]);
  // Base58 encode
  return toBase58(wif);
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function toBase58(buf) {
  let num = BigInt("0x" + buf.toString("hex"));
  let result = "";
  const base = BigInt(58);
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % base)] + result;
    num = num / base;
  }
  // Leading zeros
  for (const byte of buf) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result;
}

// ─── Wallet creation ──────────────────────────────────────────────────────────

export async function createWallet(userId) {
  const col = await getMongoCollection("wallets");

  // Check if user already has a wallet
  const existing = await col.findOne({ userId: String(userId) });
  if (existing) return { exists: true, accountName: existing.accountName };

  // Generate 12-word seed phrase
  const mnemonic  = bip39.generateMnemonic(128);
  const seedBuf   = await bip39.mnemonicToSeed(mnemonic);
  const privateKeyWif = seedToEosPrivateKey(seedBuf);

  // Derive public key using eosjs
  const { PrivateKey } = await import("eosjs/dist/eosjs-jssig.js");
  const privKey   = PrivateKey.fromString(privateKeyWif);
  const pubKey    = privKey.getPublicKey().toString();

  // Account name: "xrdr" + 8 char hash of userId
  const hash      = crypto.createHash("sha256").update(String(userId)).digest("hex");
  const accountName = "xrdr" + hash.slice(0, 8); // 12 chars max on EOSIO

  // Store encrypted key in MongoDB
  await col.insertOne({
    userId:         String(userId),
    accountName,
    publicKey:      pubKey,
    privateKeyEnc:  encryptKey(privateKeyWif),
    createdAt:      new Date(),
    autoBuyXpr:     5,      // default 5 XPR per trade
    autoSellX:      3,      // default 3x target
    autoBuyEnabled: false,  // off until user explicitly enables
    autoSellEnabled: false,
  });

  return {
    exists:      false,
    mnemonic,          // shown ONCE — never stored
    publicKey:   pubKey,
    accountName,
  };
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
  await col.updateOne(
    { userId: String(userId) },
    { $set: settings }
  );
}

export async function getAllActiveAutobuyers() {
  const col = await getMongoCollection("wallets");
  return col.find({ autoBuyEnabled: true }).toArray();
}
