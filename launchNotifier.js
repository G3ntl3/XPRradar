/**
 * Launch Notifier — polls SimpleDEX for newly launched tokens
 * and pushes alerts to subscribed chats.
 */

import fetch from "node-fetch";
import fs from "fs";

const API          = "https://indexer.protonnz.com/api";
const SUBS_FILE    = "./launch_subs.json";
const SEEN_FILE    = "./seen_tokens.json";
const POLL_MS      = 30_000;  // check every 30 seconds

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadSubs() {
  try {
    if (fs.existsSync(SUBS_FILE)) return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  } catch {}
  return {};
}

function saveSubs(data) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(data, null, 2));
}

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")));
  } catch {}
  return new Set();
}

function saveSeen(set) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...set]));
}

// ─── Subscription management ──────────────────────────────────────────────────

let _autoBuyHandler = null;

export function registerAutoBuyHandler(fn) {
  _autoBuyHandler = fn;
}

export function subscribeToLaunches(chatId) {
  const subs = loadSubs();
  subs[String(chatId)] = true;
  saveSubs(subs);
}

export function unsubscribeFromLaunches(chatId) {
  const subs = loadSubs();
  delete subs[String(chatId)];
  saveSubs(subs);
}

export function isSubscribedToLaunches(chatId) {
  return !!loadSubs()[String(chatId)];
}

export function getLaunchSubCount() {
  return Object.keys(loadSubs()).length;
}

// ─── Fetch latest tokens ──────────────────────────────────────────────────────

async function fetchLatestTokens() {
  try {
    const res = await fetch(`${API}/tokens?limit=500`, {
      signal: AbortSignal.timeout(10000),
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

export function startLaunchNotifier(bot) {
  console.log("🚀 Launch notifier started.");

  // Seed seen tokens on startup so we don't spam on first run
  fetchLatestTokens().then(tokens => {
    const seen = loadSeen();
    let added = 0;
    for (const t of tokens) {
      seen.add(t.tokenId);
      added++;
    }
    saveSeen(seen);
    console.log(`Launch notifier seeded with ${added} existing tokens.`);
  }).catch(console.error);

  // Start polling after 10s delay (let seed finish)
  setTimeout(() => {
    setInterval(() => poll(bot).catch(console.error), POLL_MS);
  }, 10_000);
}

async function poll(bot) {
  const subs   = loadSubs();
  const seen   = loadSeen();
  const tokens = await fetchLatestTokens();
  const newTokens = tokens.filter(t => !seen.has(t.tokenId));

  if (!newTokens.length) return;

  // Always mark as seen — even if no subscribers, so we don't backfill later
  for (const t of newTokens) seen.add(t.tokenId);
  saveSeen(seen);

  console.log(`🆕 New tokens detected: ${newTokens.map(t => t.symbol).join(", ")}`);

  // No subscribers — nothing to send
  if (Object.keys(subs).length === 0) {
    console.log("No subscribers — skipping notifications.");
    return;
  }

  // Notify all subscribers
  for (const t of newTokens) {
    const msg = buildLaunchMsg(t);
    console.log(`📣 Notifying ${Object.keys(subs).length} subscribers about ${t.symbol}`);
    for (const chatId of Object.keys(subs)) {
      await bot.api.sendMessage(Number(chatId), msg, { parse_mode: "HTML" })
        .catch(e => console.warn(`Launch notify failed for ${chatId}: ${e.message}`));
      await new Promise(r => setTimeout(r, 100));
    }
    // Trigger auto-buy for all users who have it enabled
    if (_autoBuyHandler) {
      await _autoBuyHandler(bot, t).catch(e =>
        console.warn(`Auto-buy handler error for ${t.symbol}: ${e.message}`)
      );
    }
  }
}
