/**
 * Launch Notifier — optimized for minimum detection latency
 *
 * KEY CHANGES FROM ORIGINAL:
 * 1. Poll every 2s instead of 30s — 15x faster detection
 * 2. Subscriptions kept in memory (Map) — no file read on every check
 * 3. autoBuy fires FIRST via setImmediate, BEFORE subscriber notifications
 * 4. Subscriber notifications are parallel + fire-and-forget
 * 5. saveSeen() is async — never blocks the poll loop
 * 6. loadSubs()/saveSubs() are gone — replaced with in-memory Map
 *    (persisted to file async on change, loaded once at startup)
 */

import fetch from "node-fetch";
import fs    from "fs";

const API       = "https://indexer.protonnz.com/api";
const SUBS_FILE = "./launch_subs.json";
const SEEN_FILE = "./seen_tokens.json";
const POLL_MS   = 2_000; // 2 seconds — was 30s

// ─── In-memory state (loaded from disk once at startup) ───────────────────────

const _subs = new Map(); // chatId -> true
const _seen = new Set(); // tokenId -> true
let   _autoBuyHandler = null;
let   _bot            = null;
let   _polling        = false;

// Load subs from disk
try {
  if (fs.existsSync(SUBS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
    for (const id of Object.keys(raw)) _subs.set(id, true);
    console.log(`📋 Loaded ${_subs.size} launch subscribers`);
  }
} catch (e) { console.warn("loadSubs error:", e.message); }

// Load seen tokens from disk
try {
  if (fs.existsSync(SEEN_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    for (const id of raw) _seen.add(id);
    console.log(`👁 Loaded ${_seen.size} seen token IDs`);
  }
} catch (e) { console.warn("loadSeen error:", e.message); }

// ─── Async persistence — never blocks ────────────────────────────────────────

function persistSubs() {
  const obj = Object.fromEntries(_subs);
  fs.promises.writeFile(SUBS_FILE, JSON.stringify(obj, null, 2))
    .catch(e => console.warn("saveSubs error:", e.message));
}

function persistSeen() {
  fs.promises.writeFile(SEEN_FILE, JSON.stringify([..._seen]))
    .catch(e => console.warn("saveSeen error:", e.message));
}

// ─── Subscription management — in-memory, instant ────────────────────────────

export function registerAutoBuyHandler(fn) {
  _autoBuyHandler = fn;
}

export function subscribeToLaunches(chatId) {
  _subs.set(String(chatId), true);
  persistSubs(); // async, non-blocking
}

export function unsubscribeFromLaunches(chatId) {
  _subs.delete(String(chatId));
  persistSubs();
}

export function isSubscribedToLaunches(chatId) {
  return _subs.has(String(chatId)); // instant — no file read
}

export function getLaunchSubCount() {
  return _subs.size;
}

// ─── Fetch latest tokens ──────────────────────────────────────────────────────

async function fetchLatestTokens() {
  try {
    const res = await fetch(`${API}/tokens?limit=20&sort=createdAt&order=desc`, {
      signal: AbortSignal.timeout(3000), // aggressive — skip slow cycles
    });
    if (res.ok) {
      const data = await res.json();
      return data?.tokens ?? [];
    }
  } catch (e) {
    // Silent — we'll retry next cycle in 2s
  }
  return [];
}

// ─── Format launch alert ──────────────────────────────────────────────────────

function fmtPrice(n) {
  if (!n) return "$0";
  if (n >= 1)      return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(10)}`;
}

function fmtNum(n) {
  if (!n && n !== 0) return "N/A";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return n.toLocaleString("en", { maximumFractionDigits: 0 });
  return n.toFixed(2);
}

function buildLaunchMsg(token) {
  const statusEmoji = token.graduated ? "🎓" : "🚀";
  const status      = token.graduated ? "Graduated" : "On Curve (Bonding)";
  let msg = `${statusEmoji} <b>New Token Launched!</b>\n\n`;
  msg += `🪙 <b>${token.name}</b> (<code>${token.symbol}</code>)\n`;
  msg += `👤 Creator: <code>${token.creator}</code>\n\n`;
  msg += `💰 Price:  <code>${fmtPrice(token.price)}</code>\n`;
  msg += `📊 MCap:   <code>$${fmtNum(token.mcap)}</code>\n`;
  msg += `🏷 Status: ${status}\n`;
  if (token.description) {
    const desc = token.description.trim().slice(0, 120);
    msg += `\n📝 <i>${desc}${token.description.length > 120 ? "…" : ""}</i>\n`;
  }
  msg += `\n/token_${token.symbol}   /devcheck_${token.symbol}`;
  return msg;
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function poll() {
  if (_polling) return; // skip if previous cycle still running
  _polling = true;

  try {
    const tokens    = await fetchLatestTokens();
    const newTokens = tokens.filter(t => t.tokenId && !_seen.has(String(t.tokenId)));
    if (!newTokens.length) return;

    // Mark seen immediately — before anything else
    for (const t of newTokens) _seen.add(String(t.tokenId));
    persistSeen(); // async, won't block

    console.log(`🆕 New tokens: ${newTokens.map(t => t.symbol).join(", ")}`);

    for (const t of newTokens) {
      // ── STEP 1: Fire auto-buy IMMEDIATELY — highest priority ──────────────
      if (_autoBuyHandler && _bot) {
        setImmediate(() =>
          _autoBuyHandler(_bot, t).catch(e =>
            console.warn(`autoBuy error for ${t.symbol}:`, e.message)
          )
        );
      }

      // ── STEP 2: Notify subscribers — parallel, fire-and-forget ────────────
      if (_subs.size > 0 && _bot) {
        const msg = buildLaunchMsg(t);
        setImmediate(() => {
          const sends = [..._subs.keys()].map(chatId =>
            _bot.api.sendMessage(Number(chatId), msg, { parse_mode: "HTML" })
              .catch(() => {})
          );
          Promise.allSettled(sends).catch(() => {});
        });
      }
    }
  } catch (e) {
    console.warn("Poll error:", e.message);
  } finally {
    _polling = false;
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

export function startLaunchNotifier(bot) {
  _bot = bot;
  console.log(`🚀 Launch notifier started — polling every ${POLL_MS}ms`);

  // Seed on startup so we don't trigger on existing tokens
  fetchLatestTokens().then(tokens => {
    for (const t of tokens) {
      if (t.tokenId) _seen.add(String(t.tokenId));
    }
    persistSeen();
    console.log(`Launch notifier seeded: ${_seen.size} known tokens`);

    // Start polling only AFTER seed completes
    setInterval(() => poll().catch(console.error), POLL_MS);
  }).catch(() => {
    // Seed failed — start polling anyway
    setInterval(() => poll().catch(console.error), POLL_MS);
  });
}