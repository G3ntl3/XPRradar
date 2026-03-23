/**
 * Wallet Manager
 * Generates BIP39 seed phrases, derives XPR keypairs using proper
 * BIP44 derivation path m/44'/194'/0'/0/0 (EOSIO coin type 194)
 * compatible with WebAuth wallet import.
 *
 * npm install bip39 hdkey tiny-secp256k1 eosjs
 */

import crypto from "crypto";
import * as bip39 from "bip39";
import HDKey from "hdkey";
import { getMongoCollection } from "./db.js";

// EOSIO BIP44 derivation path (coin type 194)
const DERIVATION_PATH = "m/44'/194'/0'/0/0";

// ─── Encryption ───────────────────────────────────────────────────────────────

const ENC_KEY = () => {
  const k = process.env.WALLET_ENCRYPT_KEY || "change-me-to-32-char-random-key!";
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

// ─── EOSIO WIF encoding ───────────────────────────────────────────────────────

const BASE58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function toBase58(buf) {
  let num    = BigInt("0x" + buf.toString("hex"));
  let result = "";
  const base = BigInt(58);
  while (num > 0n) {
    result = BASE58_ALPHA[Number(num % base)] + result;
    num    = num / base;
  }
  for (const byte of buf) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result;
}

function privateKeyToWif(rawPrivKeyHex) {
  const keyBuf  = Buffer.from(rawPrivKeyHex, "hex");
  const payload = Buffer.concat([Buffer.from([0x80]), keyBuf]);
  const h1      = crypto.createHash("sha256").update(payload).digest();
  const h2      = crypto.createHash("sha256").update(h1).digest();
  const full    = Buffer.concat([payload, h2.slice(0, 4)]);
  return toBase58(full);
}

// ─── EOSIO public key encoding ────────────────────────────────────────────────

function publicKeyToEos(pubKeyBuf) {
  // Checksum = RIPEMD160 of compressed public key
  const checksum = crypto.createHash("ripemd160").update(pubKeyBuf).digest().slice(0, 4);
  const full     = Buffer.concat([pubKeyBuf, checksum]);
  return "PUB_K1_" + toBase58(full);
}

// ─── Derive keypair from mnemonic ─────────────────────────────────────────────

export async function deriveKeypairFromMnemonic(mnemonic) {
  const seed       = await bip39.mnemonicToSeed(mnemonic);
  const hdkey      = HDKey.fromMasterSeed(seed);
  const child      = hdkey.derive(DERIVATION_PATH);

  const privKeyHex = child.privateKey.toString("hex");
  const pubKeyBuf  = child.publicKey; // compressed 33 bytes

  const wif        = privateKeyToWif(privKeyHex);
  const pubKey     = publicKeyToEos(pubKeyBuf);

  return { wif, pubKey, privKeyHex };
}

// ─── Wallet creation ──────────────────────────────────────────────────────────

export async function createWallet(userId) {
  const col = await getMongoCollection("wallets");

  const existing = await col.findOne({ userId: String(userId) });
  if (existing) return { exists: true, accountName: existing.accountName };

  // Generate 12-word BIP39 mnemonic
  const mnemonic = bip39.generateMnemonic(128);

  // Derive keypair using proper BIP44 path
  const { wif, pubKey } = await deriveKeypairFromMnemonic(mnemonic);

  // Account name: "xrdr" + 8 char hash (max 12 chars on EOSIO)
  const hash        = crypto.createHash("sha256").update(String(userId)).digest("hex");
  const accountName = "xrdr" + hash.slice(0, 8);

  await col.insertOne({
    userId:          String(userId),
    accountName,
    publicKey:       pubKey,
    privateKeyEnc:   encryptKey(wif),
    createdAt:       new Date(),
    autoBuyXpr:      5,
    autoSellX:       3,
    autoBuyEnabled:  false,
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
  await col.updateOne({ userId: String(userId) }, { $set: settings });
}

export async function getAllActiveAutobuyers() {
  const col = await getMongoCollection("wallets");
  return col.find({ autoBuyEnabled: true }).toArray();
}
