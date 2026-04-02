/**
 * Trader — optimized for speed
 *
 * SPEED OPTIMIZATIONS:
 * 1. Pre-warmed API pool — connections ready before any trade arrives
 * 2. buyTokens() uses cached Api instances — zero get_info() calls on hot path
 * 3. No balance check inside buyTokens — caller decides
 * 4. No precision fetch on buy path — sell uses it, buy doesn't need it
 * 5. rpcPost() tries endpoints in parallel with Promise.any for read calls
 */

import { Api, JsonRpc } from "eosjs";
import { JsSignatureProvider } from "eosjs/dist/eosjs-jssig.js";
import fetch from "node-fetch";
import { getPrivateKey } from "./wallet.js";

const RPC_ENDPOINTS = [
  "https://api.protonnz.com",
  "https://mainnet-api.xprdata.org",
  "https://proton.eosusa.io",
  "https://proton.greymass.com",
];

const CONTRACT     = "simplelaunch";
const XPR_CONTRACT = "eosio.token";
const XPR_SYMBOL   = "XPR";
const XPR_DECIMALS = 4;

const MASTER_ACCOUNT = process.env.MASTER_ACCOUNT;
const MASTER_KEY     = process.env.MASTER_PRIVATE_KEY;

// ─── Pre-warmed API pool ──────────────────────────────────────────────────────
// We keep one cached JsonRpc per endpoint and pre-test them at startup.
// buyTokens() uses the first endpoint that responded — no runtime get_info().

const _rpcPool = RPC_ENDPOINTS.map(base => new JsonRpc(base, { fetch }));
let _bestRpcIndex = 0; // index of the fastest responding endpoint

async function warmPool() {
  const results = await Promise.allSettled(
    _rpcPool.map((rpc, i) =>
      rpc.get_info().then(() => i)
    )
  );
  const firstOk = results.find(r => r.status === "fulfilled");
  if (firstOk) {
    _bestRpcIndex = firstOk.value;
    console.log(`✅ RPC pool warmed — best endpoint: ${RPC_ENDPOINTS[_bestRpcIndex]}`);
  }
}

// Warm immediately and re-warm every 60s
warmPool();
setInterval(warmPool, 60_000);

// ─── Get best available RPC (cached, no network call) ────────────────────────

function getBestRpc() {
  return _rpcPool[_bestRpcIndex];
}

// Get a signed Api using the cached best RPC — no get_info() call
function getCachedApi(privateKeyWif) {
  const rpc = getBestRpc();
  const sig = new JsSignatureProvider([privateKeyWif]);
  return new Api({ rpc, signatureProvider: sig, textEncoder: new TextEncoder(), textDecoder: new TextDecoder() });
}

// Fallback: try endpoints one by one (for sell/balance — correctness > speed)
async function getWorkingApi(privateKeyWif) {
  for (let i = 0; i < _rpcPool.length; i++) {
    const idx = (i + _bestRpcIndex) % _rpcPool.length;
    try {
      await _rpcPool[idx].get_info();
      const sig = new JsSignatureProvider([privateKeyWif]);
      return new Api({ rpc: _rpcPool[idx], signatureProvider: sig, textEncoder: new TextEncoder(), textDecoder: new TextDecoder() });
    } catch {}
  }
  return getCachedApi(privateKeyWif); // last resort
}

// ─── Parallel RPC read — fastest endpoint wins ───────────────────────────────
// For read-only calls (balance, table rows) we race all endpoints

async function rpcPostFastest(path, body, timeoutMs = 6000) {
  const requests = RPC_ENDPOINTS.map(base =>
    fetch(`${base}${path}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(timeoutMs),
    }).then(async res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
  );

  try {
    return await Promise.any(requests);
  } catch {
    throw new Error("All RPC endpoints failed");
  }
}

// Serial fallback for writes (we need to know which endpoint to use)
async function rpcPost(path, body, timeoutMs = 8000) {
  let lastError;
  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    const base = RPC_ENDPOINTS[(i + _bestRpcIndex) % RPC_ENDPOINTS.length];
    try {
      const res = await fetch(`${base}${path}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) { lastError = new Error(`HTTP ${res.status} from ${base}`); continue; }
      return await res.json();
    } catch (e) {
      console.warn(`RPC ${base} failed: ${e.message}`);
      lastError = e;
    }
  }
  throw lastError ?? new Error("All RPC endpoints failed");
}

function fmtXpr(amount) {
  return `${parseFloat(amount).toFixed(XPR_DECIMALS)} ${XPR_SYMBOL}`;
}

function rawTokenAmount(amount, precision = 4) {
  return Math.round(parseFloat(amount) * Math.pow(10, precision));
}

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

// ─── XPR balance (parallel — fastest wins) ───────────────────────────────────

export async function getXprBalance(accountName) {
  try {
    const data = await rpcPostFastest("/v1/chain/get_currency_balance", {
      code: XPR_CONTRACT, account: accountName, symbol: XPR_SYMBOL,
    });
    if (!Array.isArray(data) || !data.length) return 0;
    return parseFloat(data[0].split(" ")[0]);
  } catch (e) {
    console.warn("getXprBalance error:", e.message);
    return 0;
  }
}

// ─── Bonding curve balance (parallel — fastest wins) ─────────────────────────

export async function getBondingBalance(accountName, tokenId, precision = 4) {
  try {
    const data = await rpcPostFastest("/v1/chain/get_table_rows", {
      code: CONTRACT, scope: accountName, table: "holdings", json: true, limit: 100,
    });
    const row = (data?.rows ?? []).find(r => String(r.tokenId) === String(tokenId));
    if (!row) return 0;
    return row.amount / Math.pow(10, precision);
  } catch (e) {
    console.warn("getBondingBalance error:", e.message);
    return 0;
  }
}

// ─── All bonding holdings ─────────────────────────────────────────────────────

export async function getBondingBalanceRaw(accountName, tokenId) {
  try {
    const data = await rpcPost("/v1/chain/get_table_rows", {
      code:  CONTRACT,
      scope: accountName,
      table: "holdings",
      json:  true,
      limit: 100,
    });
    const rows = data?.rows ?? [];
    const row  = rows.find(r => String(r.tokenId) === String(tokenId));
    return row ? row.amount : 0; // raw uint64
  } catch (e) {
    console.warn("getBondingBalanceRaw error:", e.message);
    return 0;
  }
}

export async function getAllHoldings(accountName) {
  try {
    const data = await rpcPostFastest("/v1/chain/get_table_rows", {
      code: CONTRACT, scope: accountName, table: "holdings", json: true, limit: 100,
    });
    return (data?.rows ?? []).map(r => ({ tokenId: r.tokenId, amount: r.amount / 10000 }));
  } catch (e) {
    console.warn("getAllHoldings error:", e.message);
    return [];
  }
}

// ─── Token precision ─────────────────────────────────────────────────────────

export async function getTokenPrecision(symbol, contract = "eosio.token") {
  try {
    const data = await rpcPostFastest("/v1/chain/get_table_rows", {
      code: contract, scope: symbol, table: "stat", json: true,
    });
    const supply = data?.rows?.[0]?.supply;
    if (!supply) return 4;
    const parts = supply.split(" ")[0].split(".");
    return parts.length > 1 ? parts[1].length : 0;
  } catch { return 4; }
}

// ─── Token balance ────────────────────────────────────────────────────────────

export async function getTokenBalance(accountName, symbol, tokenId = null, contract = "eosio.token") {
  try {
    if (tokenId != null) {
      const b = await getBondingBalance(accountName, tokenId);
      if (b > 0) return b;
    }
    const data = await rpcPostFastest("/v1/chain/get_currency_balance", {
      code: contract, account: accountName, symbol,
    });
    if (Array.isArray(data) && data.length) return parseFloat(data[0].split(" ")[0]);
    return 0;
  } catch { return 0; }
}

// ─── BUY — SPEED CRITICAL PATH ───────────────────────────────────────────────
// Uses pre-warmed cached Api — NO get_info() call, NO balance check.
// Caller (autoTrader) is responsible for balance checks if needed.

export async function buyTokens({ userId, accountName, tokenId, xprAmount }) {
  const privateKey = await getPrivateKey(userId);
  if (!privateKey) throw new Error("No wallet found for user");

  // Use cached Api — fastest possible path
  const api = getCachedApi(privateKey);

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
    // If cached endpoint failed, retry once with a working endpoint
    console.warn(`buyTokens: cached endpoint failed (${e.message}), retrying with fallback…`);
    const fallbackApi = await getWorkingApi(privateKey);
    try {
      return await fallbackApi.transact({
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
    } catch (e2) {
      console.error("buyTokens error:", JSON.stringify(e2?.json ?? e2?.message ?? e2));
      throw new Error(extractEosError(e2));
    }
  }
}

// ─── SELL ─────────────────────────────────────────────────────────────────────

export async function sellTokens({ userId, accountName, tokenId, tokenAmount, symbol, precision = null }) {
  const privateKey = await getPrivateKey(userId);
  if (!privateKey) throw new Error("No wallet found for user");

  const actualPrecision = precision ?? await getTokenPrecision(symbol).catch(() => 4);

  let amount = 0;
  if (tokenId != null) amount = await getBondingBalance(accountName, tokenId, actualPrecision);
  if (!amount && tokenAmount) amount = parseFloat(tokenAmount);
  if (!amount && symbol) {
    try {
      const data = await rpcPostFastest("/v1/chain/get_currency_balance", { code: "eosio.token", account: accountName, symbol });
      if (Array.isArray(data) && data.length) amount = parseFloat(data[0].split(" ")[0]);
    } catch {}
  }

  if (!amount || amount <= 0) throw new Error("No token balance to sell");

  const rawAmount = rawTokenAmount(amount, actualPrecision);
  console.log(`sellTokens: ${amount} ${symbol ?? ""} (raw: ${rawAmount}) tokenId=${tokenId}`);

  // ★ fetch wrapper with hard 15s timeout — prevents api.transact() from hanging forever
  function fetchWithTimeout(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  // ★ Try each RPC node in order — move to next if transact hangs or fails
  const sig = new JsSignatureProvider([privateKey]);
  let lastError;

  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    const base = RPC_ENDPOINTS[(i + _bestRpcIndex) % RPC_ENDPOINTS.length];
    try {
      const rpc = new JsonRpc(base, { fetch: fetchWithTimeout });
      const api = new Api({
        rpc,
        signatureProvider: sig,
        textEncoder: new TextEncoder(),
        textDecoder: new TextDecoder(),
      });

      // Race transact against a 20s hard timeout
      const result = await Promise.race([
        api.transact({
          actions: [{
            account:       CONTRACT,
            name:          "sell",
            authorization: [{ actor: accountName, permission: "active" }],
            data: { seller: accountName, tokenId, tokenAmount: rawAmount, minXpr: 0 },
          }],
        }, { blocksBehind: 3, expireSeconds: 60 }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`RPC ${base} timed out after 20s`)), 20_000)
        ),
      ]);

      console.log(`sellTokens: success via ${base}`);
      return result;

    } catch (e) {
      const msg = e?.message ?? String(e);
      // Don't retry on on-chain assertion errors — those are final
      if (msg.includes("assertion failure") || msg.includes("Insufficient")) {
        console.error("sellTokens chain error:", msg);
        throw new Error(extractEosError(e));
      }
      console.warn(`sellTokens: ${base} failed — ${msg} — trying next node`);
      lastError = e;
    }
  }

  console.error("sellTokens: all nodes failed:", lastError?.message);
  throw new Error(extractEosError(lastError) ?? "All RPC nodes failed for sell");
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
    const account = await getBestRpc().get_account(accountName).catch(() => null);
    return { xpr, account };
  } catch (e) {
    console.warn("getAllBalances error:", e.message);
    return { xpr: 0 };
  }
}