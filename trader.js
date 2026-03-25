/**
 * Trader — signs and pushes buy/sell transactions to simplelaunch contract
 *
 * Buy:  transfer XPR to simplelaunch with memo "buy:<tokenId>"
 * Sell: { seller, tokenId, tokenAmount, minXpr }
 *
 * RPC FALLBACK: api.protonnz.com times out intermittently.
 * We maintain a list of fallback endpoints and try each in order.
 *
 * BONDING CURVE BALANCES — confirmed from contract ABI:
 *   table:  "holdings"
 *   struct: Holding { tokenId: uint64, amount: uint64 }
 *   scope:  accountName
 *   amount is raw uint64 / 10000 = float tokens
 */

import { Api, JsonRpc } from "eosjs";
import { JsSignatureProvider } from "eosjs/dist/eosjs-jssig.js";
import fetch from "node-fetch";
import { getPrivateKey } from "./wallet.js";

// ─── RPC endpoints — tried in order, first success wins ──────────────────────
const RPC_ENDPOINTS = [
  "https://api.protonnz.com",
  "https://mainnet-api.xprdata.org",
  "https://proton.eosusa.io",
  "https://proton.greymass.com",
];

const CONTRACT      = "simplelaunch";
const XPR_CONTRACT  = "eosio.token";
const XPR_SYMBOL    = "XPR";
const XPR_DECIMALS  = 4;
const MASTER_ACCOUNT = process.env.MASTER_ACCOUNT;
const MASTER_KEY     = process.env.MASTER_PRIVATE_KEY;

// ─── Resilient fetch — tries each RPC endpoint until one works ───────────────

async function rpcPost(path, body, timeoutMs = 8000) {
  let lastError;
  for (const base of RPC_ENDPOINTS) {
    try {
      const res = await fetch(`${base}${path}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status} from ${base}`);
        continue;
      }
      return await res.json();
    } catch (e) {
      console.warn(`RPC ${base}${path} failed: ${e.message}`);
      lastError = e;
    }
  }
  throw lastError ?? new Error("All RPC endpoints failed");
}

// ─── Get a working JsonRpc instance — tries each endpoint ────────────────────

async function getWorkingRpc() {
  for (const base of RPC_ENDPOINTS) {
    try {
      const rpc = new JsonRpc(base, { fetch });
      await rpc.get_info(); // quick connectivity check
      return rpc;
    } catch (e) {
      console.warn(`RPC endpoint ${base} unavailable: ${e.message}`);
    }
  }
  // Last resort — return first endpoint even if it timed out (may recover)
  return new JsonRpc(RPC_ENDPOINTS[0], { fetch });
}

// ─── Get a working eosjs Api instance ────────────────────────────────────────

async function getWorkingApi(privateKeyWif) {
  for (const base of RPC_ENDPOINTS) {
    try {
      const rpc = new JsonRpc(base, { fetch });
      await rpc.get_info();
      const sig = new JsSignatureProvider([privateKeyWif]);
      return new Api({ rpc, signatureProvider: sig, textEncoder: new TextEncoder(), textDecoder: new TextDecoder() });
    } catch (e) {
      console.warn(`API endpoint ${base} unavailable: ${e.message}`);
    }
  }
  // Fallback — use first endpoint
  const rpc = new JsonRpc(RPC_ENDPOINTS[0], { fetch });
  const sig = new JsSignatureProvider([privateKeyWif]);
  return new Api({ rpc, signatureProvider: sig, textEncoder: new TextEncoder(), textDecoder: new TextDecoder() });
}

function fmtXpr(amount) {
  return `${parseFloat(amount).toFixed(XPR_DECIMALS)} ${XPR_SYMBOL}`;
}

function rawTokenAmount(amount, precision = 4) {
  return Math.floor(parseFloat(amount) * Math.pow(10, precision));
}

// ─── Extract readable error from eosjs ───────────────────────────────────────

export function extractEosError(e) {
  try {
    if (e?.json?.error) {
      const details = e.json.error.details;
      if (Array.isArray(details) && details.length) return details[0].message ?? e.json.error.what ?? "Unknown chain error";
      return e.json.error.what ?? "Unknown chain error";
    }
    return e?.message || String(e) || "Unknown error";
  } catch { return "Unknown error"; }
}

// ─── XPR balance ─────────────────────────────────────────────────────────────

export async function getXprBalance(accountName) {
  try {
    const data = await rpcPost("/v1/chain/get_currency_balance", {
      code: XPR_CONTRACT, account: accountName, symbol: XPR_SYMBOL,
    });
    if (!Array.isArray(data) || !data.length) return 0;
    return parseFloat(data[0].split(" ")[0]);
  } catch (e) {
    console.warn("getXprBalance error:", e.message);
    return 0;
  }
}

// ─── Bonding curve token balance ─────────────────────────────────────────────
// Table: "holdings", scope: accountName, struct: { tokenId, amount }

export async function getBondingBalance(accountName, tokenId) {
  try {
    const data = await rpcPost("/v1/chain/get_table_rows", {
      code:  CONTRACT,
      scope: accountName,
      table: "holdings",
      json:  true,
      limit: 100,
    });

    const rows = data?.rows ?? [];
    console.log(`getBondingBalance: account=${accountName} rows=${rows.length}`, JSON.stringify(rows));

    const row = rows.find(r => String(r.tokenId) === String(tokenId));
    if (!row) return 0;

    const amount = row.amount / 10000;
    console.log(`getBondingBalance: found ${amount} (raw: ${row.amount}) tokenId=${tokenId}`);
    return amount;

  } catch (e) {
    console.warn("getBondingBalance error:", e.message);
    return 0;
  }
}

// ─── All bonding holdings for an account ─────────────────────────────────────

export async function getAllHoldings(accountName) {
  try {
    const data = await rpcPost("/v1/chain/get_table_rows", {
      code:  CONTRACT,
      scope: accountName,
      table: "holdings",
      json:  true,
      limit: 100,
    });
    return (data?.rows ?? []).map(r => ({
      tokenId: r.tokenId,
      amount:  r.amount / 10000,
    }));
  } catch (e) {
    console.warn("getAllHoldings error:", e.message);
    return [];
  }
}

// ─── Token balance (graduated fallback) ──────────────────────────────────────

export async function getTokenBalance(accountName, symbol, tokenId = null, contract = "eosio.token") {
  try {
    if (tokenId != null) {
      const bondingAmt = await getBondingBalance(accountName, tokenId);
      if (bondingAmt > 0) return bondingAmt;
    }
    const rpc  = await getWorkingRpc();
    const rows = await rpc.get_currency_balance(contract, accountName, symbol).catch(() => []);
    if (rows?.length) return parseFloat(rows[0].split(" ")[0]);
    return 0;
  } catch { return 0; }
}

// ─── Buy tokens ───────────────────────────────────────────────────────────────

export async function buyTokens({ userId, accountName, tokenId, xprAmount }) {
  const privateKey = await getPrivateKey(userId);
  if (!privateKey) throw new Error("No wallet found for user");

  const api = await getWorkingApi(privateKey);
  try {
    return await api.transact({
      actions: [{
        account:       XPR_CONTRACT,
        name:          "transfer",
        authorization: [{ actor: accountName, permission: "active" }],
        data: {
          from:     accountName,
          to:       CONTRACT,
          quantity: fmtXpr(xprAmount),
          memo:     `buy:${tokenId}`,
        },
      }],
    }, { blocksBehind: 3, expireSeconds: 30 });
  } catch (e) {
    console.error("buyTokens error:", JSON.stringify(e?.json ?? e?.message ?? e));
    throw new Error(extractEosError(e));
  }
}

// ─── Sell tokens ──────────────────────────────────────────────────────────────

export async function sellTokens({ userId, accountName, tokenId, tokenAmount, symbol, precision = 4 }) {
  const privateKey = await getPrivateKey(userId);
  if (!privateKey) throw new Error("No wallet found for user");

  // Step 1: Live holdings table balance
  let amount = 0;
  if (tokenId != null) amount = await getBondingBalance(accountName, tokenId);

  // Step 2: Stored tokenAmount fallback
  if (!amount && tokenAmount) amount = parseFloat(tokenAmount);

  // Step 3: eosio.token fallback for graduated tokens
  if (!amount && symbol) {
    try {
      const rpc  = await getWorkingRpc();
      const rows = await rpc.get_currency_balance("eosio.token", accountName, symbol).catch(() => []);
      if (rows?.length) amount = parseFloat(rows[0].split(" ")[0]);
    } catch {}
  }

  if (!amount || amount <= 0) throw new Error("No token balance to sell");

  const rawAmount = rawTokenAmount(amount, precision);
  console.log(`sellTokens: ${amount} ${symbol ?? ""} (raw: ${rawAmount}) tokenId=${tokenId}`);

  const api = await getWorkingApi(privateKey);
  try {
    return await api.transact({
      actions: [{
        account:       CONTRACT,
        name:          "sell",
        authorization: [{ actor: accountName, permission: "active" }],
        data: { seller: accountName, tokenId, tokenAmount: rawAmount, minXpr: 0 },
      }],
    }, { blocksBehind: 3, expireSeconds: 30 });
  } catch (e) {
    console.error("sellTokens error:", JSON.stringify(e?.json ?? e?.message ?? e));
    throw new Error(extractEosError(e));
  }
}

// ─── Account creation ─────────────────────────────────────────────────────────

export async function createXprAccount(newAccountName, ownerPublicKey) {
  if (!MASTER_ACCOUNT || !MASTER_KEY) throw new Error("MASTER_ACCOUNT or MASTER_PRIVATE_KEY not set in .env");
  const api = await getWorkingApi(MASTER_KEY);
  return api.transact({
    actions: [
      {
        account: "eosio", name: "newaccount",
        authorization: [{ actor: MASTER_ACCOUNT, permission: "active" }],
        data: {
          creator: MASTER_ACCOUNT, name: newAccountName,
          owner:  { threshold: 1, keys: [{ key: ownerPublicKey, weight: 1 }], accounts: [], waits: [] },
          active: { threshold: 1, keys: [{ key: ownerPublicKey, weight: 1 }], accounts: [], waits: [] },
        },
      },
      {
        account: "eosio", name: "buyrambytes",
        authorization: [{ actor: MASTER_ACCOUNT, permission: "active" }],
        data: { payer: MASTER_ACCOUNT, receiver: newAccountName, bytes: 4096 },
      },
      {
        account: "eosio", name: "delegatebw",
        authorization: [{ actor: MASTER_ACCOUNT, permission: "active" }],
        data: { from: MASTER_ACCOUNT, receiver: newAccountName, stake_net_quantity: "1.0000 SYS", stake_cpu_quantity: "1.0000 SYS", transfer: true },
      },
    ],
  }, { blocksBehind: 3, expireSeconds: 30 });
}

export async function stakeResources(accountName) {
  if (!MASTER_ACCOUNT || !MASTER_KEY) throw new Error("MASTER_ACCOUNT or MASTER_PRIVATE_KEY not set in .env");
  const api = await getWorkingApi(MASTER_KEY);
  return api.transact({
    actions: [{
      account: "eosio", name: "delegatebw",
      authorization: [{ actor: MASTER_ACCOUNT, permission: "active" }],
      data: { from: MASTER_ACCOUNT, receiver: accountName, stake_net_quantity: "1.0000 SYS", stake_cpu_quantity: "1.0000 SYS", transfer: true },
    }],
  }, { blocksBehind: 3, expireSeconds: 30 });
}

export async function getAllBalances(accountName) {
  try {
    const xpr     = await getXprBalance(accountName);
    const rpc     = await getWorkingRpc();
    const account = await rpc.get_account(accountName).catch(() => null);
    return { xpr, account };
  } catch (e) {
    console.warn("getAllBalances error:", e.message);
    return { xpr: 0 };
  }
}