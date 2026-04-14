/**
 * Mirror Trader — copy-trade on SimpleDEX
 *
 * Multi-target support:
 * - Each user can mirror multiple wallets simultaneously
 * - Each (userId, target) pair gets its own independent poll loop,
 *   dedup key set, and sell lock — they never interfere with each other
 * - _mirrors: Map<userId, Map<target, session>>
 * - _sellLock: Map<"userId:target:tokenId", true>
 *
 * Other key features:
 * 1. Composite dedup key (txId:global_sequence) prevents skipping same-txId actions
 * 2. Per-target per-token sell lock prevents duplicate sells
 * 3. HTML-safe fetch with node fallback
 * 4. Positions + wallet updated on every mirror trade
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

// _mirrors: Map<userId (string), Map<target (string), session>>
const _mirrors  = new Map();

// _sellLock: Map<"userId:target:tokenId", true>
const _sellLock = new Map();

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

// ─── Composite dedup key ──────────────────────────────────────────────────────

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

    if (account === XPR_TOKEN && name === "transfer") {
      if ((data?.from ?? "").toLowerCase() !== target.toLowerCase()) return null;
      if (data?.to !== SIMPLEDEX) return null;
      const memo    = data?.memo ?? "";
      if (!memo.startsWith("buy:")) return null;
      const tokenId = parseInt(memo.split(":")[1]);
      if (!tokenId || isNaN(tokenId)) return null;
      return { type: "buy", tokenId, txId };
    }

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

async function executeBuy(userId, session, swap, bot) {
  const balance = await getXprBalance(session.accountName);
  if (balance < session.xprAmount) {
    await bot.api.sendMessage(Number(userId),
      `⚠️ <b>Mirror buy skipped — low balance</b>\nTarget: <code>${session.target}</code>\nHave: <code>${balance.toFixed(4)} XPR</code>  Need: <code>${session.xprAmount} XPR</code>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

  const result = await buyTokens({ userId, accountName: session.accountName, tokenId: swap.tokenId, xprAmount: session.xprAmount });
  const txId   = result?.transaction_id?.slice(0, 32) ?? "confirmed";
  const symbol = await getSymbol(swap.tokenId);
  
  const tokenInfo = await getToken(symbol);
  const entryMcap = tokenInfo?.mcap ?? 0;
  const tokenName = tokenInfo?.name ?? symbol;

  try {
    await openPosition({
      userId, accountName: session.accountName,
      symbol, tokenId: swap.tokenId, tokenName,
      xprSpent: session.xprAmount, tokenAmount: 0, entryMcap,
      autoSellX: 3, autoSellSL: 0.6, precision: 4,
      openedAt: Math.floor(Date.now() / 1000),
    });
    saveSnapshot(userId, symbol, entryMcap);
  } catch {}

  await bot.api.sendMessage(Number(userId),
    `🪞 <b>Mirror Buy!</b>\n\n` +
    `🎯 Copied: <code>${session.target}</code>\n` +
    `🪙 Token:  <code>${symbol}</code>\n` +
    `💰 Spent:  <code>${session.xprAmount} XPR</code>\n` +
    `🔗 TX: <code>${txId}...</code>`,
    { parse_mode: "HTML" }
  ).catch(() => {});
}

// ─── Execute mirror sell ──────────────────────────────────────────────────────

async function executeSell(userId, session, swap, bot) {
  const lockKey = `${userId}:${session.target}:${swap.tokenId}`;
  if (_sellLock.get(lockKey)) {
    console.log(`[mirror sell] LOCKED — tokenId=${swap.tokenId} target=${session.target}`);
    return;
  }
  _sellLock.set(lockKey, true);

  try {
    const symbol = await getSymbol(swap.tokenId);

    let balance = 0;
    for (let i = 0; i < 4; i++) {
      balance = await getBondingBalance(session.accountName, swap.tokenId);
      if (balance > 0) break;
      await new Promise(r => setTimeout(r, 700));
    }

    if (!balance || balance <= 0) {
      console.log(`[mirror sell] no balance tokenId=${swap.tokenId} target=${session.target} — skipping`);
      return;
    }

    const rawAmount  = Math.floor(balance * 10000);
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
        authorization: [{ actor: session.accountName, permission: "active" }],
        data: { seller: session.accountName, tokenId: swap.tokenId, tokenAmount: rawAmount, minXpr: 0 },
      }],
    }, { blocksBehind: 3, expireSeconds: 120 });

    const txId = result?.transaction_id?.slice(0, 32) ?? "confirmed";

    try {
      const pos = await getPosition(userId, symbol);
      if (pos) await closePosition({ userId, symbol, xprReceived: pos.xprSpent });
    } catch {}

    await bot.api.sendMessage(Number(userId),
      `🪞 <b>Mirror Sell!</b>\n\n` +
      `🎯 Copied: <code>${session.target}</code>\n` +
      `🪙 Sold:   <code>${balance.toFixed(4)} ${symbol}</code>\n` +
      `🔗 TX: <code>${txId}...</code>`,
      { parse_mode: "HTML" }
    ).catch(() => {});

  } finally {
    setTimeout(() => _sellLock.delete(lockKey), 10_000);
  }
}

// ─── Poll loop (one per userId+target pair) ───────────────────────────────────

async function poll(userId, target, bot) {
  const userMirrors = _mirrors.get(String(userId));
  if (!userMirrors) return;

  const session = userMirrors.get(target);
  if (!session || !session.isRunning) return;

  try {
    const actions = await fetchActions(target);

    for (const action of actions) {
      const key = actionKey(action);
      if (session.seenKeys.has(key)) continue;
      session.seenKeys.add(key);

      let actionTs = action["@timestamp"] ?? action.timestamp ?? null;
      if (actionTs) {
        if (!actionTs.endsWith("Z")) actionTs += "Z";
        const actionSec = Math.floor(new Date(actionTs).getTime() / 1000);
        if (actionSec < session.startedAtSec) continue;
      }

      const swap = parseAction(action, target);
      if (!swap) continue;

      console.log(`🪞 [${target}] ${swap.type} tokenId=${swap.tokenId} (user=${userId})`);

      if (swap.type === "buy") {
        executeBuy(userId, session, swap, bot).catch(e => {
          console.error(`Mirror buy error [${target}]:`, e.message);
          bot.api.sendMessage(Number(userId),
            `⚠️ <b>Mirror buy failed</b>\nTarget: <code>${target}</code>\nToken: <code>${swap.tokenId}</code>\nError: <code>${e.message}</code>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        });
      }

      if (swap.type === "sell") {
        executeSell(userId, session, swap, bot).catch(e => {
          console.error(`Mirror sell error [${target}]:`, e.message);
          bot.api.sendMessage(Number(userId),
            `⚠️ <b>Mirror sell failed</b>\nTarget: <code>${target}</code>\nToken: <code>${swap.tokenId}</code>\nError: <code>${e.message}</code>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        });
      }
    }

    if (session.seenKeys.size > 1000) {
      const arr = [...session.seenKeys];
      session.seenKeys = new Set(arr.slice(-500));
    }
  } catch (e) {
    console.warn(`Mirror poll error [${target}]:`, e.message);
  }

  if (session.isRunning) {
    session.timeoutId = setTimeout(() => poll(userId, target, bot).catch(console.error), POLL_MS);
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

/**
 * Start mirroring a target wallet for a user.
 * Multiple calls with DIFFERENT targets run in parallel.
 * Calling with the SAME target replaces only that session.
 */
export async function startMirror(userId, target, xprAmount, accountName, bot) {
  const uid = String(userId);
  target = target.toLowerCase();

  stopMirror(userId, target); // stop this specific target if already running

  if (!_mirrors.has(uid)) _mirrors.set(uid, new Map());
  const userMirrors = _mirrors.get(uid);

  await warmTokenCache();

  const startedAt    = Date.now();
  const startedAtSec = Math.floor(startedAt / 1000);

  console.log(`🪞 Mirror LIVE: ${accountName} -> ${target} | userId=${uid}`);
  console.log(`🪞 Cutoff: ${new Date(startedAt).toISOString()} — older actions ignored`);

  const session = {
    target, xprAmount, accountName,
    isRunning:   true,
    seenKeys:    new Set(),
    startedAt,
    startedAtSec,
    timeoutId:   null,
  };

  userMirrors.set(target, session);
  session.timeoutId = setTimeout(() => poll(uid, target, bot).catch(console.error), POLL_MS);
}

/**
 * Stop mirroring.
 * stopMirror(userId, target) — stop one specific target
 * stopMirror(userId)         — stop ALL targets for this user
 */
export function stopMirror(userId, target = null) {
  const uid = String(userId);
  const userMirrors = _mirrors.get(uid);
  if (!userMirrors) return false;

  if (target) {
    target = target.toLowerCase();
    const session = userMirrors.get(target);
    if (!session) return false;
    session.isRunning = false;
    if (session.timeoutId) clearTimeout(session.timeoutId);
    userMirrors.delete(target);
    if (userMirrors.size === 0) _mirrors.delete(uid);
    console.log(`🪞 Mirror stopped: userId=${uid} target=${target}`);
    return true;
  } else {
    for (const session of userMirrors.values()) {
      session.isRunning = false;
      if (session.timeoutId) clearTimeout(session.timeoutId);
    }
    _mirrors.delete(uid);
    console.log(`🪞 All mirrors stopped for userId=${uid}`);
    return true;
  }
}

/** Get all active sessions for a user as an array */
export function getMirrors(userId) {
  const userMirrors = _mirrors.get(String(userId));
  if (!userMirrors) return [];
  return [...userMirrors.values()];
}

/** Get one session by target. No target = first session (legacy compat) */
export function getMirror(userId, target = null) {
  const userMirrors = _mirrors.get(String(userId));
  if (!userMirrors) return null;
  if (target) return userMirrors.get(target.toLowerCase()) ?? null;
  return userMirrors.values().next().value ?? null;
}

export function isMirroring(userId)      { return (_mirrors.get(String(userId))?.size ?? 0) > 0; }
export function getMirrorSession(userId) { return getMirror(userId); }
