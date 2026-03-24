import "dotenv/config";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { getToken, getAllTokens, getTrades, getHolders, getBondingProgress } from "./xprApi.js";
import { runDevCheck } from "./devcheck.js";
import { saveSnapshot, getSnapshot, getUserSnapshots } from "./snapshots.js";
import { generatePnlCard } from "./pnlCard.js";
import { startLaunchNotifier, subscribeToLaunches, unsubscribeFromLaunches, isSubscribedToLaunches, registerAutoBuyHandler } from "./launchNotifier.js";
import { createWallet, getWallet, updateWalletSettings, isValidXprName } from "./wallet.js";
import { buyTokens, sellTokens, getXprBalance, getTokenBalance, stakeResources } from "./trader.js";
import { openPosition, closePosition, getOpenPositions, getTradeHistory, getPosition } from "./positions.js";
import { startPositionMonitor, autoBuyNewToken } from "./autoTrader.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");

const bot = new Bot(BOT_TOKEN);

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPrice(n) {
  if (!n) return "$0";
  if (n >= 1)      return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(10)}`;
}

function fmtNum(n) {
  if (!n && n !== 0) return "N/A";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)         return n.toLocaleString("en", { maximumFractionDigits: 2 });
  return n.toFixed(2);
}

function fmtChange(n) {
  if (n === null || n === undefined) return "—";
  const sign  = n >= 0 ? "+" : "";
  const emoji = n >= 0 ? "🟢" : "🔴";
  return `${emoji} ${sign}${n.toFixed(2)}%`;
}

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// Safe timestamp formatter — handles both unix int and ISO string
function fmtTime(ts) {
  if (!ts) return "—";
  try {
    const d = typeof ts === "string" ? new Date(ts) : new Date(ts * 1000);
    if (isNaN(d.getTime())) return "—";
    return d.toISOString().slice(11, 16) + " UTC";
  } catch { return "—"; }
}

function fmtDateTime(ts) {
  if (!ts) return "—";
  try {
    const d = typeof ts === "string" ? new Date(ts) : new Date(ts * 1000);
    if (isNaN(d.getTime())) return "—";
    return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  } catch { return "—"; }
}

function timeSince(ts) {
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60)                    return `${secs}s ago`;
  if (secs < 3600)                  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)                 return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// Graduation mcap target on SimpleDEX
// Based on observed data: KARMA graduated at ~$264 mcap, MOTHER at $234 is still on-curve
// The bonding curve target appears to be ~$300 USD mcap
// bondingBar is now async — fetches real on-chain progress
async function bondingBar(token) {
  if (token.graduated) {
    return `🎓 <b>Graduated</b>\n   <code>████████████████████</code> 100%`;
  }

  // Try real on-chain data first
  if (token.tokenId) {
    try {
      const bp = await getBondingProgress(token.tokenId);
      if (bp) {
        const pct    = Math.min(bp.pct, 99.9);
        const filled = Math.round(pct / 5);
        const empty  = 20 - filled;
        const bar    = "█".repeat(filled) + "░".repeat(empty);
        const label  = pct >= 75 ? "🔥" : pct >= 50 ? "📈" : pct >= 25 ? "⚡" : "🌱";
        const xprFmt = bp.realXpr >= 1000
          ? (bp.realXpr / 1000).toFixed(1) + "K"
          : bp.realXpr.toFixed(1);
        const tgtFmt = bp.threshold >= 1000
          ? (bp.threshold / 1000).toFixed(0) + "K"
          : bp.threshold.toFixed(0);
        return (
          `${label} <b>Bonding Progress</b>\n` +
          `   <code>${bar}</code> ${pct.toFixed(1)}%\n` +
          `   ${xprFmt} XPR / ${tgtFmt} XPR target`
        );
      }
    } catch (e) {
      console.warn("bondingBar on-chain fetch failed:", e.message);
    }
  }

  // Fallback — show just graduated status
  return `📈 <b>On Curve</b> — progress unavailable`;
}

function bondStatus(token) {
  if (token.graduated) return "🎓 Graduated";
  return "📈 On Curve";
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await ctx.reply(
    `👋 <b>XPR Radar</b> — SimpleDEX Bot\n\n` +
    `Track, analyze and trade tokens on <a href="https://dex.protonnz.com">dex.protonnz.com</a>\n\n` +
    `<b>📊 Info Commands</b>\n` +
    `/token &lt;SYMBOL&gt; — Full token info\n` +
    `/price &lt;SYMBOL&gt; — Quick price\n` +
    `/trades &lt;SYMBOL&gt; — Recent swaps\n` +
    `/holders &lt;SYMBOL&gt; — Top holders\n` +
    `/devcheck &lt;SYMBOL&gt; — Dev wallet risk check\n` +
    `/tokens — Browse all listed tokens\n\n` +
    `<b>📈 PNL Tracking</b>\n` +
    `/pnl &lt;SYMBOL&gt; — MCap change since last check\n` +
    `/pnl — See all tracked tokens\n\n` +
    `<b>🔔 Alerts</b>\n` +
    `/launch — New token launch notifications\n` +
    `/launch stop — Unsubscribe\n\n` +
    `<b>💰 Trading Wallet</b>\n` +
    `/wallet create &lt;name&gt; — Create trading wallet\n` +
    `/wallet address — Show deposit address\n` +
    `/balance — XPR balance + positions\n` +
    `/buy &lt;SYMBOL&gt; &lt;amount&gt; — Buy tokens (e.g. /buy MARSH 5)\n` +
    `/sell &lt;SYMBOL&gt; — Sell all tokens for symbol\n` +
    `/quote &lt;SYMBOL&gt; &lt;amount&gt; — Preview buy before executing\n` +
    `/autobuy &lt;amount&gt; — Auto-buy on new launches\n` +
    `/autosell &lt;multiplier&gt; — Auto-sell at target\n` +
    `/positions — Open trades + live PNL\n` +
    `/history — Closed trades\n\n` +
    `/help — Full command details`,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    `<b>XPR Radar — Full Command List</b>\n\n` +

    `<b>📊 Token Info</b>\n` +
    `/token MARSH — Full metadata: price, mcap, supply, volume, bonding progress\n` +
    `/price MARSH — Quick price only\n` +
    `/trades MARSH — Recent buy/sell swaps\n` +
    `/holders MARSH — Top holders with % of supply\n` +
    `/tokens — Browse all tokens on SimpleDEX\n\n` +

    `<b>🕵️ Analysis</b>\n` +
    `/devcheck MARSH — Dev wallet risk check:\n` +
    `   • Is dev still holding? How much %?\n` +
    `   • Has dev sold? Risk score 0-10\n\n` +

    `<b>📈 PNL Tracking</b>\n` +
    `/pnl MARSH — MCap change since last check (image card)\n` +
    `/pnl — All tracked tokens\n` +
    `Auto-tracked every time you use /token or /price\n\n` +

    `<b>🔔 Launch Alerts</b>\n` +
    `/launch — Subscribe to new token notifications\n` +
    `/launch stop — Unsubscribe\n\n` +

    `<b>💰 Trading Wallet</b>\n` +
    `/wallet create &lt;name&gt; — Create your XPR trading wallet\n` +
    `/wallet — Show wallet status\n` +
    `/wallet address — Show deposit address\n` +
    `/balance — XPR balance, positions, settings\n\n` +

    `<b>⚙️ Auto-Trading</b>\n` +
    `/autobuy 5 — Buy 5 XPR on every new launch\n` +
    `/autobuy off — Disable auto-buy\n` +
    `/autosell 3 — Sell at 3x mcap from entry\n` +
    `/autosell off — Disable auto-sell\n\n` +

    `<b>📋 Positions</b>\n` +
    `/positions — Open trades with live PNL\n` +
    `/history — Last 10 closed trades + total PNL\n\n` +

    `<b>🛒 Manual Trading</b>\n` +
    `/quote MARSH 5 — Preview how many tokens for 5 XPR\n` +
    `/buy MARSH 5 — Buy MARSH spending 5 XPR\n` +
    `/sell MARSH — Sell all your MARSH position\n\n` +

    `<i>Data: indexer.protonnz.com · XPR Network</i>`,
    { parse_mode: "HTML" }
  );
});

// ─── Shared: build token message ─────────────────────────────────────────────
// Extracted so both /token command AND refresh callback use identical output

async function buildTokenMsg(symbol) {
  const t = await getToken(symbol);
  if (!t) return null;

  let msg = "";
  msg += `🪙 <b>${t.name}</b> (<code>${t.symbol}</code>)\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `💰 <b>Price:</b> <code>${fmtPrice(t.price)}</code>\n`;
  msg += `\n${await bondingBar(t)}\n\n`;
  msg += `📊 <b>Market</b>\n`;
  msg += `   MCap:    <code>$${fmtNum(t.mcap)}</code>\n`;
  msg += `   24h Vol: <code>$${fmtNum(t.volume24h)}</code>\n`;
  msg += `   24h:     ${fmtChange(t.change24h)}\n`;
  msg += `   7d:      ${fmtChange(t.change7d)}\n`;
  msg += `   High24h: <code>${fmtPrice(t.high24h)}</code>\n`;
  msg += `   Low24h:  <code>${fmtPrice(t.low24h)}</code>\n\n`;
  msg += `🏭 <b>Supply</b>\n`;
  msg += `   Circulating: <code>${fmtNum(t.circulatingSupply)}</code>\n`;
  msg += `   Total:       <code>${fmtNum(t.supply)}</code>\n`;
  msg += `   Max:         <code>${fmtNum(t.maxSupply)}</code>\n`;
  if (t.burned) msg += `   Burned:      <code>${fmtNum(t.burned)}</code> 🔥\n`;
  msg += `\n`;
  msg += `📈 <b>Activity (24h)</b>\n`;
  msg += `   Buys:    ${t.buys24h ?? "—"}\n`;
  msg += `   Sells:   ${t.sells24h ?? "—"}\n`;
  msg += `   Traders: ${t.uniqueTraders24h ?? "—"} unique\n`;
  msg += `   All-time traders: ${t.uniqueTradersAllTime ?? "—"}\n\n`;
  if (t.ath) {
    msg += `🏆 <b>ATH:</b> <code>${fmtPrice(t.ath)}</code>`;
    if (t.athTimestamp) msg += ` (${fmtDate(t.athTimestamp)})`;
    msg += `\n`;
  }
  if (t.creator)     msg += `👤 <b>Creator:</b> <code>${t.creator}</code>\n`;
  if (t.firstTradeAt) msg += `📅 <b>Launched:</b> ${fmtDate(t.firstTradeAt)}\n`;
  if (t.description) {
    const shortDesc = t.description.length > 120
      ? t.description.slice(0, 120) + "…"
      : t.description;
    msg += `\n📝 <i>${shortDesc}</i>\n`;
  }
  msg += `\n<i>Source: dex.protonnz.com</i>`;

  const kb = new InlineKeyboard()
    .text("🔄 Refresh",  `token:${symbol}`)
    .text("🔄 Trades",   `trades:${symbol}`)
    .row()
    .text("👥 Holders",  `holders:${symbol}`)
    .text("🕵️ Dev Check", `devcheck:${symbol}`);

  return { msg, kb, token: t };
}

// ─── /token_SYMBOL and /devcheck_SYMBOL — shortcuts from launch alerts ────────

bot.on("message:text", async (ctx, next) => {
  const text = ctx.message?.text?.trim() ?? "";
  if (text.startsWith("/token_")) {
    const symbol = text.slice(7).toUpperCase().split("@")[0];
    if (symbol) {
      ctx.match = symbol;
      return ctx.reply(`⏳ Fetching <b>${symbol}</b>…`, { parse_mode: "HTML" }).then(async loading => {
        const result = await buildTokenMsg(symbol);
        if (!result) return ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ ${symbol} not found.`);
        saveSnapshot(ctx.from.id, symbol, result.token.mcap ?? result.token.price);
        await ctx.api.editMessageText(ctx.chat.id, loading.message_id, result.msg, { parse_mode: "HTML", reply_markup: result.kb });
      });
    }
  }
  if (text.startsWith("/devcheck_")) {
    const symbol = text.slice(10).toUpperCase().split("@")[0];
    if (symbol) {
      const loading = await ctx.reply(`⏳ Running dev check for <b>${symbol}</b>…`, { parse_mode: "HTML" });
      const result  = await buildDevCheckMsg(symbol);
      if (result.error) return ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ ${result.error}`);
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id, result.msg, { parse_mode: "HTML", reply_markup: result.kb });
      return;
    }
  }
  return next();
});

// ─── /token — Full metadata ───────────────────────────────────────────────────

bot.command("token", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /token <SYMBOL>\nExample: /token MARSH");

  const loading = await ctx.reply(`⏳ Fetching <b>${symbol}</b>…`, { parse_mode: "HTML" });

  try {
    const result = await buildTokenMsg(symbol);

    if (!result) {
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
        `❌ <b>${symbol}</b> not found on SimpleDEX.\n\nUse /tokens to browse all tokens.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Auto-save price snapshot for /pnl tracking
    saveSnapshot(ctx.from.id, symbol, result.token.mcap ?? result.token.price);

    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, result.msg, {
      parse_mode: "HTML",
      reply_markup: result.kb,
    });

  } catch (e) {
    console.error(e);
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ Error fetching data. Please try again.`
    );
  }
});

// ─── /price ───────────────────────────────────────────────────────────────────

bot.command("price", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /price <SYMBOL>\nExample: /price MARSH");

  const loading = await ctx.reply(`⏳ Fetching price…`);
  const t = await getToken(symbol);

  if (!t) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ <b>${symbol}</b> not found on SimpleDEX.`, { parse_mode: "HTML" }
    );
    return;
  }

  // Auto-save price snapshot for /pnl tracking
  saveSnapshot(ctx.from.id, symbol, t.mcap ?? t.price);

  const kb = new InlineKeyboard()
    .text("📋 Full Info", `token:${symbol}`)
    .text("🔄 Refresh",   `price:${symbol}`);

  await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
    `💰 <b>${t.name}</b> (<code>${t.symbol}</code>)\n\n` +
    `Price:  <code>${fmtPrice(t.price)}</code>\n` +
    `MCap:   <code>$${fmtNum(t.mcap)}</code>\n` +
    `24h:    ${fmtChange(t.change24h)}\n` +
    `Status: ${bondStatus(t)}\n\n` +
    `<i>dex.protonnz.com</i>`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

// ─── /trades ──────────────────────────────────────────────────────────────────

bot.command("trades", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /trades <SYMBOL>\nExample: /trades MARSH");

  const loading = await ctx.reply(`⏳ Fetching recent trades…`);
  const trades = await getTrades(symbol, 5);

  if (!trades.length) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ No recent trades found for <b>${symbol}</b>.`, { parse_mode: "HTML" }
    );
    return;
  }

  let msg = `🔄 <b>Recent ${symbol} Trades</b>\n\n`;
  for (const t of trades) {
    const type   = t.type === "buy" ? "🟢 BUY " : "🔴 SELL";
    const time   = fmtTime(t.timestamp);
    const trader = t.account ?? t.trader ?? "unknown";
    const price  = t.price  ? fmtPrice(t.price)  : "—";
    const amount = t.amount ? fmtNum(t.amount)    : "—";
    msg += `${type}  ${price}  ×${amount}\n`;
    msg += `   👤 <code>${trader}</code>  🕐 ${time}\n\n`;
  }
  msg += `<i>Source: dex.protonnz.com</i>`;

  await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, { parse_mode: "HTML" });
});

// ─── /holders ─────────────────────────────────────────────────────────────────

bot.command("holders", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /holders <SYMBOL>\nExample: /holders MARSH");

  const loading = await ctx.reply(`⏳ Fetching holders…`);
  const holders = await getHolders(symbol, 10);

  if (!holders.length) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ No holder data found for <b>${symbol}</b>.`, { parse_mode: "HTML" }
    );
    return;
  }

  // Get supply for percentage calculation
  const tokenInfo = await getToken(symbol);
  const supply = tokenInfo?.circulatingSupply ?? tokenInfo?.supply ?? 0;

  let msg = `👥 <b>${symbol} Top Holders</b>\n\n`;
  holders.forEach((h, i) => {
    const account   = h.account ?? "unknown";
    const walletAmt = parseFloat(h.walletAmount ?? h.amount ?? 0);
    const lpAmt     = parseFloat(h.lpAmount ?? 0);
    const total     = walletAmt + lpAmt;
    const pct       = supply > 0 ? (total / supply * 100) : 0;
    msg += `${i + 1}. <code>${account}</code>\n`;
    msg += `   💼 ${fmtNum(total)} ${symbol}`;
    if (pct > 0) msg += `  <b>(${pct.toFixed(2)}%)</b>`;
    if (lpAmt > 0) msg += `\n   🏦 LP: ${fmtNum(lpAmt)}`;
    msg += `\n\n`;
  });
  msg += `<i>Source: dex.protonnz.com</i>`;

  await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, { parse_mode: "HTML" });
});

// ─── /tokens ──────────────────────────────────────────────────────────────────

bot.command("tokens", async (ctx) => {
  const loading = await ctx.reply("⏳ Loading all tokens…");
  const { tokens, count } = await getAllTokens();

  console.log(`/tokens — fetched ${tokens.length} unique tokens, API count: ${count}`);

  if (!tokens.length) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, "❌ Could not fetch token list.");
    return;
  }

  // Telegram messages max 4096 chars — split into pages of 50
  const PAGE = 50;
  const pages = [];
  for (let i = 0; i < tokens.length; i += PAGE) {
    pages.push(tokens.slice(i, i + PAGE));
  }

  // Send first page as edit of loading message
  const buildPage = (page, pageNum, total) => {
    let msg = `🪙 <b>SimpleDEX Tokens</b> (${total} total) — Page ${pageNum}/${pages.length}\n\n`;
    for (const t of page) {
      const status = t.graduated ? "🎓" : "📈";
      msg += `${status} <b>${t.symbol}</b> — ${fmtPrice(t.price)} · $${fmtNum(t.mcap)}\n`;
    }
    msg += `\n<i>Use /token SYMBOL for full details</i>`;
    return msg;
  };

  await ctx.api.editMessageText(
    ctx.chat.id, loading.message_id,
    buildPage(pages[0], 1, count),
    { parse_mode: "HTML" }
  );

  // Send remaining pages as new messages
  for (let i = 1; i < pages.length; i++) {
    await ctx.reply(buildPage(pages[i], i + 1, count), { parse_mode: "HTML" });
  }
});

// ─── /pnl ─────────────────────────────────────────────────────────────────────

bot.command("pnl", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();

  // No symbol — show all tracked tokens
  if (!symbol) {
    const all = getUserSnapshots(ctx.from.id);
    const entries = Object.entries(all);
    if (!entries.length) {
      return ctx.reply(
        `📭 No tokens tracked yet.\n\n` +
        `Just use /token or /price on any token and it gets tracked automatically.\n` +
        `Then come back and run /pnl SYMBOL to see what changed.`
      );
    }
    let msg = `📊 <b>Your Tracked Tokens</b>\n\n`;
    for (const [sym, snap] of entries) {
      const ago = timeSince(snap.timestamp);
      msg += `• <b>${sym}</b> — last checked ${ago}\n`;
      msg += `   MCap at check: <code>$${fmtNum(snap.price)}</code>\n\n`;
    }
    msg += `<i>Run /pnl SYMBOL for full PNL breakdown</i>`;
    return ctx.reply(msg, { parse_mode: "HTML" });
  }

  const loading = await ctx.reply(`⏳ Calculating PNL for <b>${symbol}</b>…`, { parse_mode: "HTML" });

  // Get saved snapshot
  const snap = getSnapshot(ctx.from.id, symbol);
  if (!snap) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ No saved price for <b>${symbol}</b>.\n\n` +
      `Use /token ${symbol} or /price ${symbol} first — the bot will track it automatically from that point.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Get current mcap
  const t = await getToken(symbol);
  if (!t) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ Could not fetch current data for <b>${symbol}</b>.`, { parse_mode: "HTML" }
    );
    return;
  }

  // mcapThen: what was stored at snapshot time
  // If old snapshot stored price (tiny number < 1), use current mcap as fallback
  const storedVal = snap.price ?? 0;
  const mcapNow   = t.mcap ?? 0;
  const mcapThen  = storedVal > 1 ? storedVal : mcapNow; // old price snapshots get current mcap

  const pctChange = mcapThen > 0 ? ((mcapNow - mcapThen) / mcapThen) * 100 : 0;
  const xChange   = mcapThen > 0 ? mcapNow / mcapThen : 1;
  // Keep priceThen/priceNow for text fallback
  const priceThen = mcapThen;
  const priceNow  = mcapNow;

  const kb = new InlineKeyboard()
    .text("🔄 Update Snapshot", `price:${symbol}`)
    .text("📋 Token Info",      `token:${symbol}`);

  // Delete the loading message first
  await ctx.api.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});

  // Try to generate the PNL card image
  try {
    const imageBuffer = await generatePnlCard({
      symbol,
      tokenName:     t.name,
      mcapThen,
      mcapNow,
      pctChange,
      xChange,
      snapTimestamp: snap.timestamp,
    });

    await ctx.replyWithPhoto(
      new InputFile(imageBuffer, `pnl_${symbol}.jpg`),
      { reply_markup: kb }
    );

  } catch (imgErr) {
    // canvas not installed yet — fall back to text
    console.warn("PNL card failed (canvas not installed?):", imgErr.message);

    const isUp  = priceNow >= priceThen;
    const arrow = isUp ? "📈" : "📉";
    const sign  = isUp ? "+" : "";
    const emoji = isUp ? "🟢" : "🔴";
    let xStr = "";
    if (xChange >= 1.1)      xStr = `  |  <b>+${xChange.toFixed(2)}x</b>`;
    else if (xChange <= 0.9) xStr = `  |  <b>${xChange.toFixed(2)}x</b>`;

    let msg = `📊 <b>PNL — ${t.name} (${symbol})</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `⏱ <b>Last checked:</b> ${timeSince(snap.timestamp)}\n\n`;
    msg += `📊 <b>MCap then:</b>  <code>$${fmtNum(mcapThen)}</code>\n`;
    msg += `📊 <b>MCap now:</b>   <code>$${fmtNum(mcapNow)}</code>\n\n`;
    msg += `${arrow} <b>Change:</b>  ${emoji} <code>${sign}${pctChange.toFixed(2)}%</code>${xStr}\n\n`;
    msg += `<i>Snapshot: ${fmtDateTime(snap.timestamp)}</i>`;

    await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
  }
});

// ─── /devcheck ────────────────────────────────────────────────────────────────

bot.command("devcheck", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply(
    "Usage: /devcheck <SYMBOL>\nExample: /devcheck MARSH"
  );

  const loading = await ctx.reply(
    `⏳ Analysing dev wallet for <b>${symbol}</b>…\n<i>This may take a few seconds</i>`,
    { parse_mode: "HTML" }
  );

  try {
    const result = await buildDevCheckMsg(symbol);

    if (result.error) {
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
        `❌ ${result.error}`, { parse_mode: "HTML" }
      );
      return;
    }

    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, result.msg, {
      parse_mode: "HTML",
      reply_markup: result.kb,
    });

  } catch (e) {
    console.error("devcheck error:", e);
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ Error running dev check. Please try again.`
    );
  }
});

// ─── buildDevCheckMsg helper (used by command + refresh button) ───────────────

async function buildDevCheckMsg(symbol) {
  const r = await runDevCheck(symbol);
  if (r.error) return { error: r.error };

  let msg = "";
  msg += `🕵️ <b>Dev Check — ${r.tokenName} (${r.symbol})</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `👤 <b>Creator:</b> <code>${r.creator}</code>\n\n`;

  msg += `💼 <b>Current Holdings</b>\n`;
  if (!r.balanceKnown) {
    msg += `   Balance: <code>⚪ Not in top 500 holders</code>\n`;
    msg += `   Status:  ❓ Unable to confirm — may hold small amount\n\n`;
  } else if (r.currentBalance > 0) {
    const holdingEmoji = r.holdingPct >= 10 ? "🔴" : r.holdingPct >= 5 ? "🟡" : "🟢";
    msg += `   Balance: <code>${fmtNum(r.currentBalance)} ${r.symbol}</code>\n`;
    msg += `   Share:   ${holdingEmoji} <code>${r.holdingPct.toFixed(2)}%</code> of supply\n`;
    msg += `   Value:   <code>~$${fmtNum(r.valueUsd)}</code>\n`;
    msg += `   Status:  🟢 Still Holding\n\n`;
  } else {
    msg += `   Balance: <code>0 ${r.symbol}</code>\n`;
    msg += `   Status:  🔴 Dev holds nothing — fully exited\n\n`;
  }

  msg += `📤 <b>Sell Activity</b>\n`;
  if (r.totalSold > 0) {
    const soldPct = r.totalSupply > 0 ? (r.totalSold / r.totalSupply * 100).toFixed(2) : "?";
    msg += `   Total Sold: <code>${fmtNum(r.totalSold)} ${r.symbol}</code> (${soldPct}%)\n`;
    msg += `   Sell Txns:  ${r.sellCount}\n`;
    if (r.lastSell?.timestamp) {
      msg += `   Last Sell:  ${fmtDateTime(r.lastSell.timestamp)}\n`;
    }
  } else {
    msg += `   Total Sold: 0 — never sold ✅\n`;
  }
  msg += `\n`;

  if (r.suspiciousTransfers.length > 0) {
    msg += `🔀 <b>Token Transfers to Other Wallets</b>\n`;
    for (const w of r.suspiciousTransfers.slice(0, 5)) {
      const freshTag = w.isFresh ? " ⚠️ <i>fresh wallet</i>" : "";
      msg += `   → <code>${w.to}</code>${freshTag}\n`;
      msg += `      ${fmtNum(w.amount)} ${r.symbol}\n`;
    }
    msg += `\n`;
  } else {
    msg += `🔀 <b>Wallet Transfers:</b> None detected ✅\n\n`;
  }

  if (r.flags.length > 0) {
    msg += `⚠️ <b>Risk Flags</b>\n`;
    for (const f of r.flags) msg += `   ${f}\n`;
    msg += `\n`;
  }

  if (r.positive.length > 0) {
    msg += `✅ <b>Positive Signals</b>\n`;
    for (const p of r.positive) msg += `   ${p}\n`;
    msg += `\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `${r.riskEmoji} <b>Risk Score: ${r.riskScore}/10 — ${r.riskLabel}</b>\n`;
  msg += `<code>${"█".repeat(r.riskScore)}${"░".repeat(10 - r.riskScore)}</code>\n\n`;
  msg += `<i>⚠️ Always DYOR. This is not financial advice.</i>\n`;
  msg += `<i>Source: dex.protonnz.com · XPR Network</i>`;

  const kb = new InlineKeyboard()
    .text("🔄 Refresh",    `devcheck:${symbol}`)
    .text("📋 Token Info", `token:${symbol}`);

  return { msg, kb };
}

// ─── Inline callbacks ─────────────────────────────────────────────────────────

bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery();
  const [action, symbol] = ctx.callbackQuery.data.split(":");

  if (action === "token") {
    // Refresh token message in place
    const result = await buildTokenMsg(symbol);
    if (!result) return ctx.answerCallbackQuery("Token not found");
    saveSnapshot(ctx.from.id, symbol, result.token.mcap ?? result.token.price);
    await ctx.editMessageText(result.msg, {
      parse_mode: "HTML",
      reply_markup: result.kb,
    }).catch(() => ctx.reply(result.msg, { parse_mode: "HTML", reply_markup: result.kb }));

  } else if (action === "price") {
    const t = await getToken(symbol);
    if (!t) return ctx.answerCallbackQuery("No data found");
    saveSnapshot(ctx.from.id, symbol, t.mcap ?? t.price);
    const kb = new InlineKeyboard()
      .text("📋 Full Info", `token:${symbol}`)
      .text("🔄 Refresh",   `price:${symbol}`);
    await ctx.editMessageText(
      `💰 <b>${t.name}</b> (<code>${t.symbol}</code>)\n\n` +
      `Price:  <code>${fmtPrice(t.price)}</code>\n` +
      `MCap:   <code>$${fmtNum(t.mcap)}</code>\n` +
      `24h:    ${fmtChange(t.change24h)}\n` +
      `Status: ${bondStatus(t)}\n\n` +
      `<i>dex.protonnz.com</i>`,
      { parse_mode: "HTML", reply_markup: kb }
    ).catch(() => {});

  } else if (action === "trades") {
    const trades = await getTrades(symbol, 5);
    if (!trades.length) return ctx.reply(`❌ No recent trades for <b>${symbol}</b>`, { parse_mode: "HTML" });
    let msg = `🔄 <b>Recent ${symbol} Trades</b>\n\n`;
    for (const t of trades) {
      const type = t.type === "buy" ? "🟢 BUY " : "🔴 SELL";
      const time = fmtTime(t.timestamp);
      msg += `${type}  ${fmtPrice(t.price)}  ×${fmtNum(t.amount)}\n`;
      msg += `   👤 <code>${t.account ?? "unknown"}</code>  🕐 ${time}\n\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML" });

  } else if (action === "holders") {
    const holders = await getHolders(symbol, 10);
    if (!holders.length) return ctx.reply(`❌ No holder data found for <b>${symbol}</b>.`, { parse_mode: "HTML" });
    const tokenInfo = await getToken(symbol);
    const supply = tokenInfo?.circulatingSupply ?? tokenInfo?.supply ?? 0;
    let msg = `👥 <b>${symbol} Top Holders</b>\n\n`;
    holders.forEach((h, i) => {
      const account   = h.account ?? "unknown";
      const walletAmt = parseFloat(h.walletAmount ?? h.amount ?? 0);
      const lpAmt     = parseFloat(h.lpAmount ?? 0);
      const total     = walletAmt + lpAmt;
      const pct       = supply > 0 ? (total / supply * 100) : 0;
      msg += `${i + 1}. <code>${account}</code>\n`;
      msg += `   💼 ${fmtNum(total)} ${symbol}`;
      if (pct > 0) msg += `  <b>(${pct.toFixed(2)}%)</b>`;
      if (lpAmt > 0) msg += `\n   🏦 LP: ${fmtNum(lpAmt)}`;
      msg += `\n\n`;
    });
    msg += `<i>Source: dex.protonnz.com</i>`;
    await ctx.reply(msg, { parse_mode: "HTML" });

  } else if (action === "devcheck") {
    // Use editMessageText to refresh in place
    await ctx.editMessageText(
      `⏳ Refreshing dev check for <b>${symbol}</b>…`, { parse_mode: "HTML" }
    ).catch(() => {});
    const result = await buildDevCheckMsg(symbol);
    if (result.error) {
      await ctx.editMessageText(`❌ ${result.error}`).catch(() => {});
      return;
    }
    await ctx.editMessageText(result.msg, {
      parse_mode: "HTML",
      reply_markup: result.kb,
    }).catch(() => ctx.reply(result.msg, { parse_mode: "HTML", reply_markup: result.kb }));
  }
});

// ─── /launch — subscribe to new token notifications ──────────────────────────

bot.command("launch", async (ctx) => {
  const arg = ctx.match?.trim().toLowerCase();

  if (arg === "stop" || arg === "off" || arg === "unsubscribe") {
    unsubscribeFromLaunches(ctx.chat.id);
    await ctx.reply(
      `🔕 <b>Launch notifications off.</b>\n\nUse /launch to turn them back on.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // Toggle — if already subscribed, show status
  if (isSubscribedToLaunches(ctx.chat.id)) {
    await ctx.reply(
      `✅ <b>Already subscribed to launch alerts!</b>\n\n` +
      `You'll get notified when new tokens launch on SimpleDEX.\n\n` +
      `Use <code>/launch stop</code> to unsubscribe.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  subscribeToLaunches(ctx.chat.id);
  await ctx.reply(
    `🚀 <b>Launch alerts ON!</b>\n\n` +
    `You'll be notified whenever a new token launches on:\n` +
    `<a href="https://dex.protonnz.com">dex.protonnz.com</a>\n\n` +
    `Each alert includes:\n` +
    `• Token name & symbol\n` +
    `• Creator wallet\n` +
    `• Starting price & mcap\n` +
    `• Bonding curve status\n` +
    `• Quick links to /token and /devcheck\n\n` +
    `Use <code>/launch stop</code> to unsubscribe.`,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

// ─── /wallet ──────────────────────────────────────────────────────────────────

bot.command("wallet", async (ctx) => {
  const arg = ctx.match?.trim().toLowerCase();

  // /wallet fix — stake resources for existing wallet
  if (arg === "fix") {
    const wallet = await getWallet(ctx.from.id);
    if (!wallet) return ctx.reply("❌ No wallet found. Use /wallet create &lt;name&gt; first.");
    const loading = await ctx.reply(`⏳ Staking resources for <code>${wallet.accountName}</code>…`, { parse_mode: "HTML" });
    try {
      await stakeResources(wallet.accountName);
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
        `✅ <b>Resources staked!</b>\n\n` +
        `Account <code>${wallet.accountName}</code> now has NET and CPU bandwidth.\n` +
        `You can now execute trades.`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
        `❌ Staking failed: ${e.message}`
      ).catch(() => {});
    }
    return;
  }

  // /wallet address
  if (arg === "address") {
    const wallet = await getWallet(ctx.from.id);
    if (!wallet) return ctx.reply("❌ No wallet found. Use /wallet create <name> first.");
    return ctx.reply(
      `📬 <b>Your Trading Wallet</b>\n\n` +
      `Account: <code>${wallet.accountName}</code>\n\n` +
      `Send XPR to this account name to fund your trading.`,
      { parse_mode: "HTML" }
    );
  }

  // /wallet create <name>
  if (arg?.startsWith("create")) {
    const parts       = arg.split(/\s+/);
    const chosenName  = parts[1]?.toLowerCase();

    // Show usage if no name provided
    if (!chosenName) {
      return ctx.reply(
        `📝 <b>Choose your XPR account name</b>\n\n` +
        `Rules:\n` +
        `• 3–12 characters long\n` +
        `• Only letters a-z and numbers 1-5\n` +
        `• No spaces, no special characters\n\n` +
        `Example: <code>/wallet create myname</code>\n` +
        `Example: <code>/wallet create trader123</code> ❌ (contains 6-9)\n` +
        `Example: <code>/wallet create trader12</code> ✅`,
        { parse_mode: "HTML" }
      );
    }

    // Validate name
    if (!isValidXprName(chosenName)) {
      return ctx.reply(
        `❌ <b>Invalid account name: <code>${chosenName}</code></b>\n\n` +
        `Rules:\n` +
        `• 3–12 characters\n` +
        `• Only: a-z and 1-5\n` +
        `• No: 6 7 8 9 0 or special characters\n\n` +
        `Try again: /wallet create <name>`,
        { parse_mode: "HTML" }
      );
    }

    // Check existing wallet
    const existing = await getWallet(ctx.from.id);
    if (existing) {
      return ctx.reply(
        `✅ <b>You already have a wallet</b>\n\n` +
        `📬 Account: <code>${existing.accountName}</code>\n\n` +
        `Use /balance to check your balance.`,
        { parse_mode: "HTML" }
      );
    }

    const loading = await ctx.reply(`⏳ Creating wallet <code>${chosenName}</code>…`, { parse_mode: "HTML" });

    try {
      const result = await createWallet(ctx.from.id, chosenName);

      if (result.nameTaken) {
        await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
          `❌ <b>Name taken</b>\n\n${result.onChain ? `<code>${chosenName}</code> already exists on XPR Network.` : `<code>${chosenName}</code> is already used in this bot.`}\n\nTry: /wallet create &lt;name&gt;`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const creationStatus = result.accountCreated
        ? `✅ Account registered on XPR Network — ready to receive XPR`
        : `⚠️ On-chain registration failed: ${result.creationError}`;

      await ctx.api.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
      await ctx.reply(
        `🎉 <b>Wallet Created!</b>\n\n` +
        `📬 <b>Account:</b> <code>${result.accountName}</code>\n` +
        `🔑 <b>Public Key:</b> <code>${result.publicKey}</code>\n\n` +
        `🌱 <b>Seed Phrase (SAVE THIS NOW):</b>\n` +
        `<tg-spoiler>${result.mnemonic}</tg-spoiler>\n\n` +
        `⚠️ <b>IMPORTANT:</b>\n` +
        `• Write this down offline and store safely\n` +
        `• This will NEVER be shown again\n` +
        `• Anyone with this phrase controls your funds\n` +
        `• Import into WebAuth app to access manually\n\n` +
        `${creationStatus}\n\n` +
        `💰 Fund your wallet: send XPR to <code>${result.accountName}</code>\n` +
        `Then set up trading with /autobuy and /autosell`,
        { parse_mode: "HTML" }
      );

    } catch (e) {
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
        `❌ Error: ${e.message}`
      ).catch(() => ctx.reply(`❌ Error: ${e.message}`));
    }
    return;
  }

  // Default — show wallet info or usage
  const wallet = await getWallet(ctx.from.id);
  if (wallet) {
    return ctx.reply(
      `💼 <b>Your Wallet</b>\n\n` +
      `Account: <code>${wallet.accountName}</code>\n` +
      `Status: ${wallet.accountCreated ? "✅ Active on-chain" : "⚠️ Not yet registered"}\n\n` +
      `Commands:\n` +
      `/wallet address — show deposit address\n` +
      `/balance — check XPR balance\n` +
      `/autobuy 5 — auto-buy 5 XPR on new launches\n` +
      `/autosell 3 — auto-sell at 3x`,
      { parse_mode: "HTML" }
    );
  }

  await ctx.reply(
    `👋 <b>XPR Trading Wallet</b>\n\n` +
    `Create your trading wallet with a custom account name:\n\n` +
    `<code>/wallet create yourname</code>\n\n` +
    `Name rules: 3-12 chars, only a-z and 1-5`,
    { parse_mode: "HTML" }
  );
});

// ─── /balance ─────────────────────────────────────────────────────────────────

bot.command("balance", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply(
    `❌ No wallet found.\n\nCreate one with: /wallet create yourname`,
    { parse_mode: "HTML" }
  );

  const loading = await ctx.reply("⏳ Checking balance…");

  const xpr = await getXprBalance(wallet.accountName);

  let positions = [];
  try { positions = await getOpenPositions(ctx.from.id); } catch {}

  let msg = `💼 <b>Wallet Balance</b>\n\n`;
  msg += `📬 Account: <code>${wallet.accountName}</code>\n`;
  msg += `💰 XPR:     <code>${xpr.toFixed(4)} XPR</code>\n\n`;

  if (positions.length) {
    msg += `📊 <b>Open Positions (${positions.length})</b>\n`;
    for (const p of positions) {
      msg += `   • ${p.symbol} — ${p.xprSpent} XPR spent\n`;
    }
    msg += `\n`;
  }

  msg += `⚙️ Auto-buy:  ${wallet.autoBuyEnabled  ? `✅ ${wallet.autoBuyXpr} XPR/trade` : "❌ Off"}\n`;
  msg += `⚙️ Auto-sell: ${wallet.autoSellEnabled ? `✅ ${wallet.autoSellX}x target`    : "❌ Off"}`;

  await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, { parse_mode: "HTML" });
});

// ─── /autobuy ─────────────────────────────────────────────────────────────────

bot.command("autobuy", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet create first.");

  const arg = ctx.match?.trim().toLowerCase();

  if (arg === "off" || arg === "stop") {
    await updateWalletSettings(ctx.from.id, { autoBuyEnabled: false });
    return ctx.reply("🔴 <b>Auto-buy disabled.</b>", { parse_mode: "HTML" });
  }

  const amount = parseFloat(arg);
  if (!amount || amount <= 0) {
    return ctx.reply(
      `⚙️ <b>Auto-Buy Settings</b>\n\n` +
      `Current: ${wallet.autoBuyEnabled ? `✅ ${wallet.autoBuyXpr} XPR per trade` : "❌ Off"}\n\n` +
      `Set amount: /autobuy 5\n` +
      `Turn off:   /autobuy off`,
      { parse_mode: "HTML" }
    );
  }

  await updateWalletSettings(ctx.from.id, {
    autoBuyEnabled: true,
    autoBuyXpr:     amount,
  });

  await ctx.reply(
    `✅ <b>Auto-buy enabled!</b>\n\n` +
    `Amount: <code>${amount} XPR</code> per new launch\n` +
    `Only buys: On-curve tokens (not graduated)\n\n` +
    `Make sure your wallet has enough XPR.\n` +
    `Use /autobuy off to disable.`,
    { parse_mode: "HTML" }
  );
});

// ─── /autosell ────────────────────────────────────────────────────────────────

bot.command("autosell", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet create first.");

  const arg = ctx.match?.trim().toLowerCase();

  if (arg === "off" || arg === "stop") {
    await updateWalletSettings(ctx.from.id, { autoSellEnabled: false });
    return ctx.reply("🔴 <b>Auto-sell disabled.</b>", { parse_mode: "HTML" });
  }

  const multiplier = parseFloat(arg);
  if (!multiplier || multiplier <= 1) {
    return ctx.reply(
      `⚙️ <b>Auto-Sell Settings</b>\n\n` +
      `Current: ${wallet.autoSellEnabled ? `✅ Sell at ${wallet.autoSellX}x` : "❌ Off"}\n\n` +
      `Set target: /autosell 3\n` +
      `Turn off:   /autosell off\n\n` +
      `Also auto-sells if token drops 60% (stop-loss).`,
      { parse_mode: "HTML" }
    );
  }

  await updateWalletSettings(ctx.from.id, {
    autoSellEnabled: true,
    autoSellX:       multiplier,
  });

  await ctx.reply(
    `✅ <b>Auto-sell enabled!</b>\n\n` +
    `Target: <code>${multiplier}x</code> from entry mcap\n` +
    `Stop-loss: <code>60%</code> drop from entry\n\n` +
    `Use /autosell off to disable.`,
    { parse_mode: "HTML" }
  );
});

// ─── /positions ───────────────────────────────────────────────────────────────

bot.command("positions", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet create first.");

  const positions = await getOpenPositions(ctx.from.id);

  if (!positions.length) {
    return ctx.reply(
      `📊 <b>No open positions.</b>\n\n` +
      `Enable auto-buy with /autobuy 5 to start trading.`,
      { parse_mode: "HTML" }
    );
  }

  let msg = `📊 <b>Open Positions (${positions.length})</b>\n\n`;

  for (const p of positions) {
    const token      = await getToken(p.symbol).catch(() => null);
    const currentMcap = token?.mcap ?? 0;
    const xMultiple  = p.entryMcap > 0 ? currentMcap / p.entryMcap : 0;
    const pnlEmoji   = xMultiple >= 1 ? "🟢" : "🔴";

    msg += `${pnlEmoji} <b>${p.symbol}</b>\n`;
    msg += `   Spent:   <code>${p.xprSpent} XPR</code>\n`;
    msg += `   Entry:   <code>$${fmtNum(p.entryMcap)}</code> mcap\n`;
    msg += `   Current: <code>$${fmtNum(currentMcap)}</code> mcap\n`;
    msg += `   P/L:     <code>${xMultiple.toFixed(2)}x</code>\n`;
    msg += `   Target:  <code>${p.autoSellX}x</code>\n\n`;
  }

  await ctx.reply(msg, { parse_mode: "HTML" });
});

// ─── /history ─────────────────────────────────────────────────────────────────

bot.command("history", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet create first.");

  const trades = await getTradeHistory(ctx.from.id, 10);

  if (!trades.length) {
    return ctx.reply("📜 No trade history yet.", { parse_mode: "HTML" });
  }

  let msg = `📜 <b>Trade History (last ${trades.length})</b>\n\n`;
  let totalPnl = 0;

  for (const t of trades) {
    const isProfit = t.pnlXpr >= 0;
    const emoji    = isProfit ? "✅" : "❌";
    totalPnl += t.pnlXpr ?? 0;
    msg += `${emoji} <b>${t.symbol}</b> — <code>${t.xMulti?.toFixed(2) ?? "?"}x</code>\n`;
    msg += `   PNL: <code>${t.pnlXpr >= 0 ? "+" : ""}${t.pnlXpr?.toFixed(4)} XPR</code>\n\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `Total PNL: <code>${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} XPR</code>`;

  await ctx.reply(msg, { parse_mode: "HTML" });
});

// ─── /quote ───────────────────────────────────────────────────────────────────

bot.command("quote", async (ctx) => {
  const parts  = ctx.match?.trim().toUpperCase().split(/\s+/);
  const symbol = parts?.[0];
  const xprAmt = parseFloat(parts?.[1]);

  if (!symbol || !xprAmt || xprAmt <= 0) {
    return ctx.reply("Usage: /quote SYMBOL AMOUNT\nExample: /quote MARSH 5");
  }

  const loading = await ctx.reply(`⏳ Getting quote for ${symbol}…`);
  const token   = await getToken(symbol);

  if (!token) {
    return ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ Token ${symbol} not found.`);
  }

  if (token.graduated) {
    return ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ ${symbol} has graduated — trading on DEX pool, not bonding curve.`);
  }

  // Estimate tokens using bonding curve formula:
  // tokens = virtualTokens * xprAmount / (virtualXpr + xprAmount)
  // All values from indexer already converted (not raw contract values)
  const price        = token.price ?? 0;
  const estTokens    = price > 0 ? xprAmt / price : 0;
  const xprUsd       = xprAmt * 0.00035; // rough XPR/USD rate
  const newMcap      = (token.mcap ?? 0) + xprUsd;
  const priceImpact  = token.mcap > 0 ? (xprUsd / token.mcap) * 100 : 0;

  await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
    `📊 <b>Quote — ${token.name} (${symbol})</b>\n\n` +
    `💰 You spend:     <code>${xprAmt} XPR</code>\n` +
    `🪙 You receive:   <code>~${fmtNum(estTokens)} ${symbol}</code>\n` +
    `📈 Price impact:  <code>~${priceImpact.toFixed(2)}%</code>\n` +
    `📊 Current MCap:  <code>$${fmtNum(token.mcap)}</code>\n` +
    `💵 Current price: <code>${fmtPrice(price)}</code>\n\n` +
    `<i>Estimate only — actual amount depends on curve state at execution</i>\n\n` +
    `To execute: /buy ${symbol} ${xprAmt}`,
    { parse_mode: "HTML" }
  );
});

// ─── /buy ─────────────────────────────────────────────────────────────────────

bot.command("buy", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet create first.");

  const parts   = ctx.match?.trim().toUpperCase().split(/\s+/);
  const symbol  = parts?.[0];
  const xprAmt  = parseFloat(parts?.[1]);

  if (!symbol || !xprAmt || xprAmt <= 0) {
    return ctx.reply(
      `Usage: /buy SYMBOL AMOUNT\nExample: /buy MARSH 5\n\n5 = spend 5 XPR`,
      { parse_mode: "HTML" }
    );
  }

  const token = await getToken(symbol);
  if (!token) return ctx.reply(`❌ Token ${symbol} not found.`);
  if (token.graduated) return ctx.reply(`❌ ${symbol} is graduated — not on bonding curve.`);

  const balance = await getXprBalance(wallet.accountName);
  if (balance < xprAmt) {
    return ctx.reply(
      `❌ Insufficient balance.\nNeed: <code>${xprAmt} XPR</code>\nHave: <code>${balance.toFixed(4)} XPR</code>`,
      { parse_mode: "HTML" }
    );
  }

  const loading = await ctx.reply(`⏳ Buying ${symbol}…`);
  try {
    await buyTokens({ userId: ctx.from.id, accountName: wallet.accountName, tokenId: token.tokenId, xprAmount: xprAmt });

    await openPosition({
      userId: ctx.from.id, accountName: wallet.accountName,
      symbol: token.symbol, tokenId: token.tokenId,
      tokenName: token.name, xprSpent: xprAmt,
      tokenAmount: 0, entryMcap: token.mcap ?? 0,
      autoSellX: wallet.autoSellX,
    });

    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `✅ <b>Bought ${symbol}!</b>\n\n` +
      `💰 Spent:  <code>${xprAmt} XPR</code>\n` +
      `📊 MCap:   <code>$${fmtNum(token.mcap)}</code>\n` +
      `🎯 Target: <code>${wallet.autoSellX}x</code>\n\n` +
      `Use /positions to track.`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ Buy failed: ${e.message}`
    ).catch(() => {});
  }
});

// ─── /sell ────────────────────────────────────────────────────────────────────

bot.command("sell", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet create first.");

  const parts  = ctx.match?.trim().toUpperCase().split(/\s+/);
  const symbol = parts?.[0];

  if (!symbol) return ctx.reply("Usage: /sell SYMBOL\nExample: /sell MARSH");

  const token    = await getToken(symbol);
  if (!token) return ctx.reply(`❌ Token ${symbol} not found.`);

  const position = await getPosition(ctx.from.id, symbol);
  if (!position) return ctx.reply(`❌ No open position for ${symbol}.`);

  const loading = await ctx.reply(`⏳ Selling ${symbol}…`);
  try {
    await sellTokens({
      userId: ctx.from.id, accountName: wallet.accountName,
      tokenId: token.tokenId, tokenAmount: position.tokenAmount, precision: 4,
    });

    const currentMcap = token.mcap ?? 0;
    const xMultiple   = position.entryMcap > 0 ? currentMcap / position.entryMcap : 1;
    const xprReceived = position.xprSpent * xMultiple;

    const closed = await closePosition({ userId: ctx.from.id, symbol, xprReceived });

    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `✅ <b>Sold ${symbol}!</b>\n\n` +
      `📈 Multiple:  <code>${xMultiple.toFixed(2)}x</code>\n` +
      `💰 Spent:     <code>${position.xprSpent.toFixed(4)} XPR</code>\n` +
      `💵 Received:  <code>${xprReceived.toFixed(4)} XPR</code>\n` +
      `📊 PNL:       <code>${closed.pnlXpr >= 0 ? "+" : ""}${closed.pnlXpr.toFixed(4)} XPR</code>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ Sell failed: ${e.message}`
    ).catch(() => {});
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

bot.catch((err) => console.error("Bot error:", err.message));
console.log("🚀 XPR Radar Bot starting...");
startLaunchNotifier(bot);
registerAutoBuyHandler(autoBuyNewToken);
startPositionMonitor(bot);
bot.start();
