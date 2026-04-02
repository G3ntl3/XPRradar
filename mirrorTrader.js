/**
 * Mirror Trader — copy-trade on SimpleDEX
 *
 * Key fixes:
 * 1. Composite dedup key (txId:global_sequence) — prevents same-txId actions being skipped
 * 2. Per-token sell lock — prevents duplicate sells for same token
 * 3. stopMirror called before startMirror — prevents double instances
 * 4. HTML-safe fetch with node fallback
 * 5. Positions + wallet updated on every mirror trade
 */

import fetch from "node-fetch";
import { buyTokens, getBondingBalance, getXprBalance } from "./trader.js";
import { openPosition, closePosition, getPosition } from "./positions.js";
import { saveSnapshot } from "./snapshots.js";
import { Api, JsonRpc } from "eosjs";
import { JsSignatureProvider } from "eosjs/dist/eosjs-jssig.js";
import { getPrivateKey } from "./wallet.js";
import { getToken } from "./xprApi.js";

const NODES = [
  "https://api.protonnz.com",
  "https://proton.eosusa.io",
  "https://proton.greymass.com",
];

const SIMPLEDEX = "simplelaunch";
const XPR_TOKEN = "eosio.token";
const POLL_MS   = 1500;

const _mirrors  = new Map();
const _sellLock = new Map(); // userId:tokenId -> true — prevents duplicate sells

// ─── Safe fetch ───────────────────────────────────────────────────────────────

async function safeGet(path) {
  for (const base of NODES) {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.trim().startsWith("<")) continue;
      return JSON.parse(text);
    } catch { continue; }
  }
  return null;
}

async function safePost(path, body) {
  for (const base of NODES) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
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
    const res  = await fetch("https://indexer.protonnz.com/api/tokens?limit=500", { signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    for (const t of data?.tokens ?? []) _tokenCache.set(String(t.tokenId), t.symbol);
  } catch {}
  return _tokenCache.get(key) ?? `#${tokenId}`;
}

// ─── Composite dedup key — handles multiple actions per txId ──────────────────

function actionKey(action) {
  const txId = action.trx_id ?? action.action_trace?.trx_id ?? "?";
  const seq  = action.global_sequence ?? action.account_action_seq ?? action["@timestamp"] ?? Math.random();
  return `${txId}:${seq}`;
}

// ─── Fetch target's recent actions ───────────────────────────────────────────

async function fetchActions(account) {
  const path = `/v2/history/get_actions?account=${encodeURIComponent(account)}&filter=${encodeURIComponent("eosio.token:transfer,simplelaunch:sell")}&limit=40&sort=desc`;
  const data = await safeGet(path);
  return data?.actions ?? [];
}

// ─── Parse action ─────────────────────────────────────────────────────────────

function parseAction(action, target) {
  try {
    const act  = action.act ?? action.action_trace?.act;
    const txId = action.trx_id ?? action.action_trace?.trx_id ?? "";
    if (!act || !txId) return null;

    const { account, name, data } = act;

    // BUY: eosio.token transfer to simplelaunch, memo starts with "buy:"
    if (account === XPR_TOKEN && name === "transfer") {
      if ((data?.from ?? "").toLowerCase() !== target.toLowerCase()) return null;
      if (data?.to !== SIMPLEDEX) return null;
      const memo    = data?.memo ?? "";
      if (!memo.startsWith("buy:")) return null;
      const tokenId = parseInt(memo.split(":")[1]);
      if (!tokenId || isNaN(tokenId)) return null;
      return { type: "buy", tokenId, txId };
    }

    // SELL: simplelaunch::sell
    if (account === SIMPLEDEX && name === "sell") {
      const seller  = (data?.seller ?? "").toLowerCase();
      if (seller !== target.toLowerCase()) return null;
      const tokenId = parseInt(data?.tokenId ?? data?.token_id ?? 0);
      if (!tokenId || isNaN(tokenId)) return null;
      return { type: "sell", tokenId, txId };
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Execute mirror buy ───────────────────────────────────────────────────────

async function executeBuy(userId, m, swap, bot) {
  const balance = await getXprBalance(m.accountName);
  if (balance < m.xprAmount) {
    await bot.api.sendMessage(Number(userId),
      `⚠️ <b>Mirror buy skipped — low balance</b>\nHave: <code>${balance.toFixed(4)} XPR</code>  Need: <code>${m.xprAmount} XPR</code>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

  const result = await buyTokens({ userId, accountName: m.accountName, tokenId: swap.tokenId, xprAmount: m.xprAmount });
  const txId   = result?.transaction_id?.slice(0, 32) ?? "confirmed";
  const symbol = await getSymbol(swap.tokenId);
  
  // Fetch real mcap and token details for accurate positions/PNL
  const tokenInfo = await getToken(symbol);
  const entryMcap = tokenInfo?.mcap ?? 0;
  const tokenName = tokenInfo?.name ?? symbol;

  // Record position
  try {
    await openPosition({
      userId, accountName: m.accountName,
      symbol, tokenId: swap.tokenId, tokenName,
      xprSpent: m.xprAmount, tokenAmount: 0, entryMcap,
      autoSellX: 3, autoSellSL: 0.6, precision: 4,
      openedAt: Math.floor(Date.now() / 1000),
    });
    saveSnapshot(userId, symbol, entryMcap);
  } catch {}

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
  // Per-token sell lock — prevents duplicate sells firing simultaneously
  const lockKey = `${userId}:${swap.tokenId}`;
  if (_sellLock.get(lockKey)) {
    console.log(`[mirror sell] LOCKED — already selling tokenId=${swap.tokenId}`);
    return;
  }
  _sellLock.set(lockKey, true);

  try {
    const symbol = await getSymbol(swap.tokenId);

    // Retry balance fetch up to 4x
    let balance = 0;
    for (let i = 0; i < 4; i++) {
      balance = await getBondingBalance(m.accountName, swap.tokenId);
      if (balance > 0) break;
      await new Promise(r => setTimeout(r, 700));
    }

    if (!balance || balance <= 0) {
      console.log(`[mirror sell] no balance for tokenId=${swap.tokenId} — skipping`);
      return;
    }

    const rawAmount = Math.floor(balance * 10000);

    // Build API
    const privateKey = await getPrivateKey(userId);
    if (!privateKey) throw new Error("No wallet found");

    let api = null;
    for (const base of NODES) {
      try {
        const rpc = new JsonRpc(base, { fetch });
        await rpc.get_info();
        const sig = new JsSignatureProvider([privateKey]);
        api = new Api({ rpc, signatureProvider: sig, textEncoder: new TextEncoder(), textDecoder: new TextDecoder() });
        break;
      } catch {}
    }
    if (!api) throw new Error("No working RPC node");

    const result = await api.transact({
      actions: [{
        account:       SIMPLEDEX,
        name:          "sell",
        authorization: [{ actor: m.accountName, permission: "active" }],
        data: { seller: m.accountName, tokenId: swap.tokenId, tokenAmount: rawAmount, minXpr: 0 },
      }],
    }, { blocksBehind: 3, expireSeconds: 120 });

    const txId = result?.transaction_id?.slice(0, 32) ?? "confirmed";

    // Close position
    try {
      const pos = await getPosition(userId, symbol);
      if (pos) await closePosition({ userId, symbol, xprReceived: pos.xprSpent });
    } catch {}

    await bot.api.sendMessage(Number(userId),
      `🪞 <b>Mirror Sell!</b>\n\n` +
      `🎯 Copied: <code>${m.target}</code>\n` +
      `🪙 Sold:   <code>${balance.toFixed(4)} ${symbol}</code>\n` +
      `🔗 TX: <code>${txId}…</code>`,
      { parse_mode: "HTML" }
    ).catch(() => {});

  } finally {
    // Release lock after 10s — prevents re-triggering on same action repoll
    setTimeout(() => _sellLock.delete(lockKey), 10_000);
  }
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function poll(userId, bot) {
  const m = _mirrors.get(String(userId));
  if (!m || !m.isRunning) return;

  try {
    const actions = await fetchActions(m.target);

    for (const action of actions) {
      const key = actionKey(action);
      if (m.seenKeys.has(key)) continue;
      m.seenKeys.add(key);

      // Strict timestamp check — reject anything older than mirror start time
      let actionTs = action["@timestamp"] ?? action.timestamp ?? null;
      if (actionTs) {
        if (!actionTs.endsWith("Z")) actionTs += "Z";
        const actionSec = Math.floor(new Date(actionTs).getTime() / 1000);
        if (actionSec < m.startedAtSec) {
          // Old action — skip silently
          continue;
        }
      }

      const swap = parseAction(action, m.target);
      if (!swap) continue;

      console.log(`🪞 [${m.target}] ${swap.type} tokenId=${swap.tokenId}`);

      if (swap.type === "buy") {
        executeBuy(userId, m, swap, bot).catch(e => {
          console.error(`Mirror buy error:`, e.message);
          bot.api.sendMessage(Number(userId),
            `⚠️ <b>Mirror buy failed</b>\nToken: <code>${swap.tokenId}</code>\nError: <code>${e.message}</code>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        });
      }

      if (swap.type === "sell") {
        executeSell(userId, m, swap, bot).catch(e => {
          console.error(`Mirror sell error:`, e.message);
          bot.api.sendMessage(Number(userId),
            `⚠️ <b>Mirror sell failed</b>\nToken: <code>${swap.tokenId}</code>\nError: <code>${e.message}</code>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        });
      }
    }

    // Trim seenKeys
    if (m.seenKeys.size > 1000) {
      const arr = [...m.seenKeys];
      m.seenKeys = new Set(arr.slice(-500));
    }
  } catch (e) {
    console.warn(`Mirror poll error:`, e.message);
  }

  if (m.isRunning) {
    m.timeoutId = setTimeout(() => poll(userId, bot).catch(console.error), POLL_MS);
  }
}

// ─── Pre-warm token cache ─────────────────────────────────────────────────────

async function warmTokenCache() {
  try {
    const res  = await fetch("https://indexer.protonnz.com/api/tokens?limit=500", {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    let count = 0;
    for (const t of data?.tokens ?? []) {
      _tokenCache.set(String(t.tokenId), t.symbol);
      count++;
    }
    console.log(`🪞 Token cache warmed: ${count} tokens`);
  } catch (e) {
    console.warn(`🪞 Token cache warm failed: ${e.message}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startMirror(userId, target, xprAmount, accountName, bot) {
  // Always stop existing first — prevents double instances
  stopMirror(userId);

  // Pre-warm token cache so symbols show correctly from first trade
  await warmTokenCache();

  // Record start timestamp — ONLY actions after this point will be executed
  // This is the reliable way to ignore history regardless of seed fetch success
  const startedAt    = Date.now();
  const startedAtSec = Math.floor(startedAt / 1000);

  console.log(`🪞 Mirror seeded 0 existing txIds for ${target} — history will be ignored`);
  console.log(`🪞 Mirror LIVE: ${accountName} → ${target} | only NEW txIds will trigger trades`);
  console.log(`🪞 Cutoff timestamp: ${new Date(startedAt).toISOString()} (actions before this are ignored)`);

  const state = {
    target, xprAmount, accountName,
    isRunning:     true,
    seenKeys:      new Set(),
    startedAt,
    startedAtSec,  // unix seconds — actions with older timestamps are ignored
    timeoutId:     null,
  };

  _mirrors.set(String(userId), state);
  state.timeoutId = setTimeout(() => poll(userId, bot).catch(console.error), POLL_MS);
}

export function stopMirror(userId) {
  const m = _mirrors.get(String(userId));
  if (!m) return false;
  m.isRunning = false;
  if (m.timeoutId) clearTimeout(m.timeoutId);
  _mirrors.delete(String(userId));
  console.log(`🪞 Mirror stopped for userId=${userId}`);
  return true;
}

export function getMirror(userId)        { return _mirrors.get(String(userId)) ?? null; }
export function getMirrorSession(userId) { return getMirror(userId); }
export function isMirroring(userId)      { return _mirrors.has(String(userId)); }
