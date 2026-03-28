/**
 * Mirror Trader — copy-trade on SimpleDEX (simplelaunch contract)
 *
 * CONFIRMED from blockchain explorer screenshot:
 *
 * BUY action (eosio.token:transfer):
 *   from: "gentle2"  to: "simplelaunch"  quantity: "0.5000 XPR"  memo: "buy:339"
 *
 * SELL action (simplelaunch:sell):
 *   seller: "gentle2"
 *   tokenId: 339          ← integer, not string
 *   tokenAmount: 209352872 ← raw uint64 (divide by 10000 for display)
 *   minXpr: 16554          ← slippage protection set by seller
 *
 * IMPORTANT: We use the RAW tokenAmount from our own holdings table
 * when mirroring a sell — NOT the target's tokenAmount.
 *
 * FILTER: Use explicit "eosio.token:transfer,simplelaunch:sell"
 * The wildcard "simplelaunch:*" does NOT work on Hyperion v2.
 */

import fetch from "node-fetch";
import { getPrivateKey } from "./wallet.js";
import { buyTokens, getBondingBalanceRaw, getXprBalance } from "./trader.js";
// import { openPosition, saveSnapshot } from "./positions.js";

const NODES = [
  "https://api.protonnz.com",
  "https://proton.eosusa.io",
  "https://proton.greymass.com",
];

const SIMPLEDEX = "simplelaunch";
const XPR_TOKEN = "eosio.token";
const POLL_MS   = 1000;

const _mirrors = new Map();

// ─── Safe fetch — handles HTML error pages and timeouts ──────────────────────

async function safeGet(path) {
  for (const base of NODES) {
    try {
      const res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(3500),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim().startsWith("<")) continue; // HTML error page
      return JSON.parse(text);
    } catch { continue; }
  }
  return null;
}

async function safePost(path, body) {
  for (const base of NODES) {
    try {
      const res = await fetch(`${base}${path}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(3500),
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim().startsWith("<")) continue;
      return JSON.parse(text);
    } catch { continue; }
  }
  return null;
}

// ─── Account validation ───────────────────────────────────────────────────────

export async function accountExistsOnChain(accountName) {
  const data = await safePost("/v1/chain/get_account", { account_name: accountName });
  return !!(data?.account_name);
}

// ─── Token symbol cache ───────────────────────────────────────────────────────

const _tokenCache = new Map();

async function getSymbol(tokenId) {
  const key = String(tokenId);
  if (_tokenCache.has(key)) return _tokenCache.get(key);
  try {
    const res = await fetch(`https://indexer.protonnz.com/api/tokens?limit=500`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      for (const t of data?.tokens ?? []) {
        _tokenCache.set(String(t.tokenId), t.symbol);
      }
    }
  } catch {}
  return _tokenCache.get(key) ?? `#${tokenId}`;
}

// ─── Fetch recent filtered actions ───────────────────────────────────────────
// CONFIRMED: use explicit action names, NOT wildcards

async function fetchActions(account) {
  // Explicit filter — simplelaunch:* wildcard does NOT work on Hyperion v2
  const path =
    `/v2/history/get_actions` +
    `?account=${encodeURIComponent(account)}` +
    `&filter=${encodeURIComponent("eosio.token:transfer,simplelaunch:sell")}` +
    `&limit=40` +
    `&sort=desc`;

  const data = await safeGet(path);
  if (!data) {
    console.warn(`Mirror: fetchActions returned null for ${account}`);
    return [];
  }

  const actions = data?.actions ?? [];
  console.log(`🔍 Mirror: ${actions.length} filtered actions for ${account}`);
  return actions;
}

// ─── Parse action using CONFIRMED field names from explorer ──────────────────

function parseAction(action, target) {
  try {
    // Hyperion v2: action.act is the top-level action object
    const act  = action.act ?? action.action_trace?.act;
    const txId = action.trx_id ?? action.action_trace?.trx_id ?? "";
    if (!act || !txId) return null;

    const { account, name, data } = act;

    // ── BUY: eosio.token transfer → simplelaunch with memo "buy:<tokenId>" ──
    if (account === XPR_TOKEN && name === "transfer") {
      const from = (data?.from ?? "").toLowerCase();
      const to   = (data?.to   ?? "").toLowerCase();
      const memo =  data?.memo ?? "";

      if (from !== target.toLowerCase()) return null;
      if (to   !== SIMPLEDEX)            return null;
      if (!memo.startsWith("buy:"))      return null;

      const tokenId = parseInt(memo.split(":")[1]);
      if (!tokenId || isNaN(tokenId)) return null;

      console.log(`  ✅ BUY detected: tokenId=${tokenId} memo=${memo} txId=${txId.slice(0,16)}`);
      return { type: "buy", tokenId, txId };
    }

    // ── SELL: simplelaunch:sell ───────────────────────────────────────────────
    // CONFIRMED fields from screenshot:
    //   seller: "gentle2"
    //   tokenId: 339          (integer)
    //   tokenAmount: 209352872
    //   minXpr: 16554
    if (account === SIMPLEDEX && name === "sell") {
      const seller  = (data?.seller ?? "").toLowerCase();
      const tokenId = parseInt(data?.tokenId ?? data?.token_id ?? 0);

      console.log(`  → sell action: seller=${seller} tokenId=${tokenId} target=${target}`);

      if (seller !== target.toLowerCase()) return null;
      if (!tokenId || isNaN(tokenId))      return null;

      console.log(`  ✅ SELL detected: tokenId=${tokenId} txId=${txId.slice(0,16)}`);
      return { type: "sell", tokenId, txId };
    }

    return null;
  } catch (e) {
    console.warn("parseAction error:", e.message);
    return null;
  }
}

// ─── Execute mirror buy ───────────────────────────────────────────────────────

async function executeBuy(userId, m, swap, bot) {
  const balance = await getXprBalance(m.accountName);
  if (balance < m.xprAmount) {
    await bot.api.sendMessage(Number(userId),
      `⚠️ <b>Mirror buy skipped — low balance</b>\n` +
      `Have: <code>${balance.toFixed(4)} XPR</code>  Need: <code>${m.xprAmount} XPR</code>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

  const result = await buyTokens({
    userId,
    accountName: m.accountName,
    tokenId:     swap.tokenId,
    xprAmount:   m.xprAmount,
  });

  const txId   = result?.transaction_id?.slice(0, 32) ?? "confirmed";
  const symbol = await getSymbol(swap.tokenId);

  console.log(`✅ Mirror buy success: ${symbol} (${swap.tokenId}) txId=${txId.slice(0,16)}`);

  await bot.api.sendMessage(Number(userId),
    `🪞 <b>Mirror Buy!</b>\n\n` +
    `🎯 Copied: <code>${m.target}</code>\n` +
    `🪙 Token:  <code>${symbol}</code>\n` +
    `💰 Spent:  <code>${m.xprAmount} XPR</code>\n` +
    `🔗 TX: <code>${txId}…</code>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
}

// ─── Execute mirror sell ──────────────────────────────────────────────────────

async function executeSell(userId, m, swap, bot) {
  const symbol = await getSymbol(swap.tokenId);

  // Fetch OUR raw balance from holdings table
  // Retry up to 5x with 700ms gaps to allow RPC consistency
  let rawBalance = 0;
  for (let i = 0; i < 5; i++) {
    rawBalance = await getBondingBalanceRaw(m.accountName, swap.tokenId);
    if (rawBalance > 0) break;
    console.log(`Mirror sell: waiting for balance... attempt ${i + 1}/5`);
    await new Promise(r => setTimeout(r, 700));
  }

  if (!rawBalance || rawBalance <= 0) {
    console.log(`Mirror sell skipped: no holdings for tokenId=${swap.tokenId} account=${m.accountName}`);
    return; // We don't hold this token — silent skip
  }

  console.log(`Mirror sell: selling raw=${rawBalance} of tokenId=${swap.tokenId} (${symbol})`);

  // Build and sign sell transaction directly using raw amount
  const privateKey = await getPrivateKey(userId);
  if (!privateKey) throw new Error("No wallet");

  const { Api, JsonRpc } = await import("eosjs");
  const { JsSignatureProvider } = await import("eosjs/dist/eosjs-jssig.js");
  const fetchLib = (await import("node-fetch")).default;

  let api;
  const nodes = [
    "https://api.protonnz.com",
    "https://proton.eosusa.io",
    "https://proton.greymass.com",
  ];
  for (const base of nodes) {
    try {
      const rpc = new JsonRpc(base, { fetch: fetchLib });
      await rpc.get_info();
      const sig = new JsSignatureProvider([privateKey]);
      api = new Api({ rpc, signatureProvider: sig, textEncoder: new TextEncoder(), textDecoder: new TextDecoder() });
      break;
    } catch {}
  }
  if (!api) throw new Error("No working RPC for sell");

  const result = await api.transact({
    actions: [{
      account:       SIMPLEDEX,
      name:          "sell",
      authorization: [{ actor: m.accountName, permission: "active" }],
      data: {
        seller:      m.accountName,
        tokenId:     swap.tokenId,   // integer
        tokenAmount: rawBalance,     // raw uint64 from holdings table
        minXpr:      0,              // no slippage protection
      },
    }],
  }, { blocksBehind: 3, expireSeconds: 120 });

  const txId = result?.transaction_id?.slice(0, 32) ?? "confirmed";

  console.log(`✅ Mirror sell success: ${symbol} raw=${rawBalance} txId=${txId.slice(0,16)}`);

  await bot.api.sendMessage(Number(userId),
    `🪞 <b>Mirror Sell!</b>\n\n` +
    `🎯 Copied: <code>${m.target}</code>\n` +
    `🪙 Sold:   <code>${(rawBalance / 10000).toFixed(4)} ${symbol}</code>\n` +
    `🔗 TX: <code>${txId}…</code>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function poll(userId, bot) {
  const m = _mirrors.get(String(userId));
  if (!m || !m.isRunning) return;

  try {
    const actions = await fetchActions(m.target);

    for (const action of actions) {
      const txId = action.trx_id ?? action.action_trace?.trx_id ?? "";
      if (!txId || m.seenTxIds.has(txId)) continue;
      m.seenTxIds.add(txId);

      const swap = parseAction(action, m.target);
      if (!swap) continue;

      console.log(`🪞 Mirror [${m.target}] ${swap.type} tokenId=${swap.tokenId} tx=${txId.slice(0,16)}`);

      if (swap.type === "buy") {
        executeBuy(userId, m, swap, bot).catch(e => {
          console.error(`Mirror buy error [${userId}]:`, e.message);
          bot.api.sendMessage(Number(userId),
            `⚠️ <b>Mirror buy failed</b>\nToken ID: <code>${swap.tokenId}</code>\nError: <code>${e.message}</code>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        });
      }

      if (swap.type === "sell") {
        executeSell(userId, m, swap, bot).catch(e => {
          console.error(`Mirror sell error [${userId}]:`, e.message);
          bot.api.sendMessage(Number(userId),
            `⚠️ <b>Mirror sell failed</b>\nToken ID: <code>${swap.tokenId}</code>\nError: <code>${e.message}</code>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        });
      }
    }

    // Keep seenTxIds bounded
    if (m.seenTxIds.size > 500) {
      const arr = [...m.seenTxIds];
      m.seenTxIds = new Set(arr.slice(-250));
    }
  } catch (e) {
    console.warn(`Mirror poll error [${userId}]:`, e.message);
  }

  // Schedule next poll only if still running
  if (m.isRunning) {
    m.timeoutId = setTimeout(() => poll(userId, bot).catch(console.error), POLL_MS);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startMirror(userId, target, xprAmount, accountName, bot) {
  stopMirror(userId);

  console.log(`🪞 Starting mirror: user=${userId} target=${target} amount=${xprAmount} account=${accountName}`);

  const state = {
    target,
    xprAmount,
    accountName,
    isRunning:  true,
    seenTxIds:  new Set(),
    startedAt:  Date.now(),
    timeoutId:  null,
  };

  // Seed to avoid replaying existing transactions
  try {
    const actions = await fetchActions(target);
    for (const a of actions) {
      const txId = a.trx_id ?? a.action_trace?.trx_id ?? "";
      if (txId) state.seenTxIds.add(txId);
    }
    console.log(`🪞 Mirror seeded: ${state.seenTxIds.size} txIds for ${target}`);
  } catch (e) {
    console.warn("Mirror seed error:", e.message);
  }

  _mirrors.set(String(userId), state);
  state.timeoutId = setTimeout(() => poll(userId, bot).catch(console.error), POLL_MS);
}

export function stopMirror(userId) {
  const m = _mirrors.get(String(userId));
  if (!m) return false;
  m.isRunning = false;
  if (m.timeoutId) clearTimeout(m.timeoutId);
  _mirrors.delete(String(userId));
  console.log(`🛑 Mirror stopped for user ${userId}`);
  return true;
}

export function getMirror(userId) {
  return _mirrors.get(String(userId)) ?? null;
}

export function getMirrorSession(userId) {
  return getMirror(userId);
}

export function isMirroring(userId) {
  return _mirrors.has(String(userId));
}