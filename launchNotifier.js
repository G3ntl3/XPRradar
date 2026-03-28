/**
 * Launch Notifier — polls SimpleDEX for newly launched tokens
 *
 * ORIGINAL LOGIC PRESERVED EXACTLY.
 * Speed improvements added:
 * - Poll every 2s instead of 30s
 * - Subscriptions in-memory (loaded from file once, no file read per check)
 * - autoBuy fires BEFORE subscriber notifications
 * - Subscriber notifications sent in parallel (no 100ms delay per user)
 * - saveSeen() is async (no blocking writeFileSync)
 */

import fetch from "node-fetch";
import fs    from "fs";

const API       = "https://indexer.protonnz.com/api";
const SUBS_FILE = "./launch_subs.json";
const SEEN_FILE = "./seen_tokens.json";
const POLL_MS   = 2_000; // was 30_000

// ─── Persistence ─────────────────────────────────────────────────────────────

// Subscriptions: load once into memory, write async on change
const _subsMap = (() => {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
      return new Map(Object.entries(raw));
    }
  } catch {}
  return new Map();
})();

function saveSubs() {
  const obj = Object.fromEntries(_subsMap);
  fs.promises.writeFile(SUBS_FILE, JSON.stringify(obj, null, 2))
    .catch(e => console.warn("saveSubs error:", e.message));
}

// Seen tokens: load once into memory, write async
const _seen = (() => {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
    }
  } catch {}
  return new Set();
})();

function saveSeen() {
  fs.promises.writeFile(SEEN_FILE, JSON.stringify([..._seen]))
    .catch(e => console.warn("saveSeen error:", e.message));
}

// ─── Subscription management ──────────────────────────────────────────────────

let _autoBuyHandler = null;

export function registerAutoBuyHandler(fn) {
  _autoBuyHandler = fn;
}

export function subscribeToLaunches(chatId) {
  _subsMap.set(String(chatId), true);
  saveSubs();
}

export function unsubscribeFromLaunches(chatId) {
  _subsMap.delete(String(chatId));
  saveSubs();
}

export function isSubscribedToLaunches(chatId) {
  return _subsMap.has(String(chatId));
}

export function getLaunchSubCount() {
  return _subsMap.size;
}

// ─── Fetch latest tokens ──────────────────────────────────────────────────────

async function fetchLatestTokens() {
  try {
    const res = await fetch(`${API}/tokens?limit=500`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      return data?.tokens ?? [];
    }
  } catch (e) {
    console.warn(`Launch notifier fetch error: ${e.message}`);
  }
  return [];
}

// ─── Format launch alert message ─────────────────────────────────────────────

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

// ─── Main polling loop ────────────────────────────────────────────────────────

let _polling = false;

export function startLaunchNotifier(bot) {
  console.log("🚀 Launch notifier started.");

  // Seed seen tokens on startup so we don't spam on first run
  fetchLatestTokens().then(tokens => {
    for (const t of tokens) {
      if (t.tokenId != null) _seen.add(t.tokenId);
    }
    saveSeen();
    console.log(`Launch notifier seeded with ${_seen.size} existing tokens.`);

    // Start polling AFTER seed finishes
    setInterval(() => poll(bot).catch(console.error), POLL_MS);
  }).catch(e => {
    console.error("Seed failed:", e.message);
    // Start anyway
    setInterval(() => poll(bot).catch(console.error), POLL_MS);
  });
}

async function poll(bot) {
  if (_polling) return; // don't overlap cycles
  _polling = true;

  try {
    const tokens    = await fetchLatestTokens();
    const newTokens = tokens.filter(t => t.tokenId != null && !_seen.has(t.tokenId));

    if (!newTokens.length) return;

    // Mark as seen immediately
    for (const t of newTokens) _seen.add(t.tokenId);
    saveSeen();

    console.log(`🆕 New tokens detected: ${newTokens.map(t => t.symbol).join(", ")}`);

    const subIds = [..._subsMap.keys()];

    for (const t of newTokens) {
      // ── Fire auto-buy FIRST before any notifications ──────────────────────
      if (_autoBuyHandler) {
        _autoBuyHandler(bot, t).catch(e =>
          console.warn(`Auto-buy handler error for ${t.symbol}: ${e.message}`)
        );
      }

      // ── Notify subscribers in parallel ────────────────────────────────────
      if (subIds.length > 0) {
        const msg = buildLaunchMsg(t);
        console.log(`📣 Notifying ${subIds.length} subscribers about ${t.symbol}`);
        Promise.allSettled(
          subIds.map(chatId =>
            bot.api.sendMessage(Number(chatId), msg, { parse_mode: "HTML" })
              .catch(e => console.warn(`Notify failed for ${chatId}: ${e.message}`))
          )
        );
      }
    }
  } catch (e) {
    console.warn("Poll error:", e.message);
  } finally {
    _polling = false;
  }
}