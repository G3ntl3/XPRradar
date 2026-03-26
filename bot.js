import "dotenv/config";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { getToken, getAllTokens, getTrades, getHolders, getBondingProgress } from "./xprApi.js";
import { runDevCheck } from "./devcheck.js";
import { saveSnapshot, getSnapshot, getUserSnapshots } from "./snapshots.js";
import { generatePnlCard } from "./pnlCard.js";
import { startLaunchNotifier, subscribeToLaunches, unsubscribeFromLaunches, isSubscribedToLaunches, registerAutoBuyHandler } from "./launchNotifier.js";
import { importWallet, getWallet, updateWalletSettings, removeWallet, isValidPrivateKey } from "./wallet.js";
import { buyTokens, sellTokens, getXprBalance, getTokenBalance, getBondingBalance, getAllHoldings, getTokenPrecision } from "./trader.js";
import { openPosition, closePosition, getOpenPositions, getTradeHistory, getPosition, updatePositionSL } from "./positions.js";
import { startPositionMonitor, autoBuyNewToken } from "./autoTrader.js";
import { startDepositMonitor } from "./depositMonitor.js";

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
  // ts can be a unix timestamp (number) or a Date object/string
  let secs;
  if (typeof ts === "number") {
    secs = Math.floor(Date.now() / 1000) - ts;
  } else {
    secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  }
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

async function bondingBar(token) {
  if (token.graduated) {
    return `🎓 <b>Graduated</b>\n   <code>████████████████████</code> 100%`;
  }
  if (token.tokenId) {
    try {
      const bp = await getBondingProgress(token.tokenId);
      if (bp) {
        const pct    = Math.min(bp.pct, 99.9);
        const filled = Math.round(pct / 5);
        const empty  = 20 - filled;
        const bar    = "█".repeat(filled) + "░".repeat(empty);
        const label  = pct >= 75 ? "🔥" : pct >= 50 ? "📈" : pct >= 25 ? "⚡" : "🌱";
        const xprFmt = bp.realXpr >= 1000 ? (bp.realXpr / 1000).toFixed(1) + "K" : bp.realXpr.toFixed(1);
        const tgtFmt = bp.threshold >= 1000 ? (bp.threshold / 1000).toFixed(0) + "K" : bp.threshold.toFixed(0);
        return `${label} <b>Bonding Progress</b>\n   <code>${bar}</code> ${pct.toFixed(1)}%\n   ${xprFmt} XPR / ${tgtFmt} XPR target`;
      }
    } catch (e) {
      console.warn("bondingBar failed:", e.message);
    }
  }
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
    `/wallet import &lt;key&gt; &lt;account&gt; — Connect WebAuth wallet\n` +
    `/wallet address — Show deposit address\n` +
    `/balance — XPR balance + positions\n` +
    `/buy &lt;SYMBOL&gt; &lt;amount&gt; — Buy tokens\n` +
    `/sell &lt;SYMBOL&gt; — Sell all tokens for symbol\n` +
    `/quote &lt;SYMBOL&gt; &lt;amount&gt; — Preview buy\n` +
    `/autobuy &lt;amount&gt; — Auto-buy on new launches\n` +
    `/autosell &lt;multiplier&gt; — Auto-sell at target\n` +
    `/stoploss &lt;percent&gt; — Default stop-loss %\n` +
    `/sl &lt;SYMBOL&gt; &lt;percent&gt; — Update SL for a trade\n` +
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
    `/token MARSH — Full metadata\n` +
    `/price MARSH — Quick price\n` +
    `/trades MARSH — Recent swaps\n` +
    `/holders MARSH — Top holders\n` +
    `/tokens — Browse all tokens\n\n` +
    `<b>🕵️ Analysis</b>\n` +
    `/devcheck MARSH — Dev wallet risk check\n\n` +
    `<b>📈 PNL Tracking</b>\n` +
    `/pnl MARSH — MCap change since buy (image card)\n` +
    `/pnl — All tracked tokens\n` +
    `Auto-tracked on every buy and /token or /price\n\n` +
    `<b>🔔 Launch Alerts</b>\n` +
    `/launch — Subscribe\n` +
    `/launch stop — Unsubscribe\n\n` +
    `<b>💰 Trading Wallet</b>\n` +
    `/wallet import &lt;key&gt; &lt;account&gt; — Connect wallet\n` +
    `/wallet — Show status\n` +
    `/wallet address — Deposit address\n` +
    `/balance — XPR balance + holdings\n\n` +
    `<b>⚙️ Auto-Trading</b>\n` +
    `/autobuy 5 — Buy 5 XPR on every launch\n` +
    `/autobuy off — Disable\n` +
    `/autosell 3 — Sell at 3x\n` +
    `/autosell off — Disable\n` +
    `/stoploss 50 — Sell if down 50%\n` +
    `/sl MARSH 40 — Set MARSH stop-loss to 40%\n\n` +
    `<b>📋 Positions</b>\n` +
    `/positions — Open trades with live PNL + buy time\n` +
    `/history — Last 10 closed trades\n\n` +
    `<b>🛒 Manual Trading</b>\n` +
    `/quote MARSH 5 — Preview\n` +
    `/buy MARSH 5 — Buy\n` +
    `/sell MARSH — Sell all\n\n` +
    `<i>Data: dex.protonnz.com · XPR Network</i>`,
    { parse_mode: "HTML" }
  );
});

// ─── Shared: build token message ─────────────────────────────────────────────

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
  if (t.creator)      msg += `👤 <b>Creator:</b> <code>${t.creator}</code>\n`;
  if (t.firstTradeAt) msg += `📅 <b>Launched:</b> ${fmtDate(t.firstTradeAt)}\n`;
  if (t.description) {
    const shortDesc = t.description.length > 120 ? t.description.slice(0, 120) + "…" : t.description;
    msg += `\n📝 <i>${shortDesc}</i>\n`;
  }
  msg += `\n<i>Source: dex.protonnz.com</i>`;

  const kb = new InlineKeyboard()
    .text("🔄 Refresh",   `token:${symbol}`)
    .text("🔄 Trades",    `trades:${symbol}`)
    .row()
    .text("👥 Holders",   `holders:${symbol}`)
    .text("🕵️ Dev Check", `devcheck:${symbol}`);

  return { msg, kb, token: t };
}

// ─── /token_SYMBOL and /devcheck_SYMBOL shortcuts ────────────────────────────

bot.on("message:text", async (ctx, next) => {
  const text = ctx.message?.text?.trim() ?? "";
  if (text.startsWith("/token_")) {
    const symbol = text.slice(7).toUpperCase().split("@")[0];
    if (symbol) {
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

// ─── /token ───────────────────────────────────────────────────────────────────

bot.command("token", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /token <SYMBOL>\nExample: /token MARSH");
  const loading = await ctx.reply(`⏳ Fetching <b>${symbol}</b>…`, { parse_mode: "HTML" });
  try {
    const result = await buildTokenMsg(symbol);
    if (!result) {
      return ctx.api.editMessageText(ctx.chat.id, loading.message_id,
        `❌ <b>${symbol}</b> not found.\n\nUse /tokens to browse.`, { parse_mode: "HTML" });
    }
    saveSnapshot(ctx.from.id, symbol, result.token.mcap ?? result.token.price);
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, result.msg, { parse_mode: "HTML", reply_markup: result.kb });
  } catch (e) {
    console.error(e);
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ Error fetching data. Please try again.`);
  }
});

// ─── /price ───────────────────────────────────────────────────────────────────

bot.command("price", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /price <SYMBOL>");
  const loading = await ctx.reply(`⏳ Fetching price…`);
  const t = await getToken(symbol);
  if (!t) return ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ <b>${symbol}</b> not found.`, { parse_mode: "HTML" });
  saveSnapshot(ctx.from.id, symbol, t.mcap ?? t.price);
  const kb = new InlineKeyboard().text("📋 Full Info", `token:${symbol}`).text("🔄 Refresh", `price:${symbol}`);
  await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
    `💰 <b>${t.name}</b> (<code>${t.symbol}</code>)\n\n` +
    `Price:  <code>${fmtPrice(t.price)}</code>\n` +
    `MCap:   <code>$${fmtNum(t.mcap)}</code>\n` +
    `24h:    ${fmtChange(t.change24h)}\n` +
    `Status: ${bondStatus(t)}\n\n` +
    `<i>dex.protonnz.com</i>`,
    { parse_mode: "HTML", reply_markup: kb });
});

// ─── /trades ──────────────────────────────────────────────────────────────────

bot.command("trades", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /trades <SYMBOL>");
  const loading = await ctx.reply(`⏳ Fetching recent trades…`);
  const trades = await getTrades(symbol, 5);
  if (!trades.length) return ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ No trades found for <b>${symbol}</b>.`, { parse_mode: "HTML" });
  let msg = `🔄 <b>Recent ${symbol} Trades</b>\n\n`;
  for (const t of trades) {
    msg += `${t.type === "buy" ? "🟢 BUY " : "🔴 SELL"}  ${t.price ? fmtPrice(t.price) : "—"}  ×${t.amount ? fmtNum(t.amount) : "—"}\n`;
    msg += `   👤 <code>${t.account ?? t.trader ?? "unknown"}</code>  🕐 ${fmtTime(t.timestamp)}\n\n`;
  }
  msg += `<i>Source: dex.protonnz.com</i>`;
  await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, { parse_mode: "HTML" });
});

// ─── /holders ─────────────────────────────────────────────────────────────────

bot.command("holders", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /holders <SYMBOL>");
  const loading = await ctx.reply(`⏳ Fetching holders…`);
  const holders = await getHolders(symbol, 10);
  if (!holders.length) return ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ No holder data for <b>${symbol}</b>.`, { parse_mode: "HTML" });
  const tokenInfo = await getToken(symbol);
  const supply = tokenInfo?.circulatingSupply ?? tokenInfo?.supply ?? 0;
  let msg = `👥 <b>${symbol} Top Holders</b>\n\n`;
  holders.forEach((h, i) => {
    const walletAmt = parseFloat(h.walletAmount ?? h.amount ?? 0);
    const lpAmt     = parseFloat(h.lpAmount ?? 0);
    const total     = walletAmt + lpAmt;
    const pct       = supply > 0 ? (total / supply * 100) : 0;
    msg += `${i + 1}. <code>${h.account ?? "unknown"}</code>\n`;
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
  if (!tokens.length) return ctx.api.editMessageText(ctx.chat.id, loading.message_id, "❌ Could not fetch token list.");
  const PAGE = 50;
  const pages = [];
  for (let i = 0; i < tokens.length; i += PAGE) pages.push(tokens.slice(i, i + PAGE));
  const buildPage = (page, pageNum, total) => {
    let msg = `🪙 <b>SimpleDEX Tokens</b> (${total} total) — Page ${pageNum}/${pages.length}\n\n`;
    for (const t of page) msg += `${t.graduated ? "🎓" : "📈"} <b>${t.symbol}</b> — ${fmtPrice(t.price)} · $${fmtNum(t.mcap)}\n`;
    msg += `\n<i>Use /token SYMBOL for full details</i>`;
    return msg;
  };
  await ctx.api.editMessageText(ctx.chat.id, loading.message_id, buildPage(pages[0], 1, count), { parse_mode: "HTML" });
  for (let i = 1; i < pages.length; i++) await ctx.reply(buildPage(pages[i], i + 1, count), { parse_mode: "HTML" });
});

// ─── /pnl ─────────────────────────────────────────────────────────────────────

bot.command("pnl", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();

  if (!symbol) {
    const all     = getUserSnapshots(ctx.from.id);
    const entries = Object.entries(all);
    if (!entries.length) return ctx.reply(`📭 No tokens tracked yet.\n\nUse /token or /price on any token, or buy one — it gets tracked automatically.`);
    let msg = `📊 <b>Your Tracked Tokens</b>\n\n`;
    for (const [sym, snap] of entries) {
      msg += `• <b>${sym}</b> — last checked ${timeSince(snap.timestamp)}\n`;
      msg += `   MCap at check: <code>$${fmtNum(snap.price)}</code>\n\n`;
    }
    msg += `<i>Run /pnl SYMBOL for full breakdown</i>`;
    return ctx.reply(msg, { parse_mode: "HTML" });
  }

  const loading = await ctx.reply(`⏳ Calculating PNL for <b>${symbol}</b>…`, { parse_mode: "HTML" });
  const snap = getSnapshot(ctx.from.id, symbol);
  if (!snap) {
    return ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ No snapshot for <b>${symbol}</b>.\n\nBuy it or use /token ${symbol} first.`, { parse_mode: "HTML" });
  }

  const t = await getToken(symbol);
  if (!t) return ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ Could not fetch <b>${symbol}</b>.`, { parse_mode: "HTML" });

  const mcapNow  = t.mcap ?? 0;
  const mcapThen = (snap.price ?? 0) > 1 ? snap.price : mcapNow;
  const pctChange = mcapThen > 0 ? ((mcapNow - mcapThen) / mcapThen) * 100 : 0;
  const xChange   = mcapThen > 0 ? mcapNow / mcapThen : 1;

  const kb = new InlineKeyboard()
    .text("🔄 Update Snapshot", `price:${symbol}`)
    .text("📋 Token Info",      `token:${symbol}`);

  await ctx.api.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});

  try {
    const imageBuffer = await generatePnlCard({
      symbol, tokenName: t.name, mcapThen, mcapNow, pctChange, xChange, snapTimestamp: snap.timestamp,
    });
    await ctx.replyWithPhoto(new InputFile(imageBuffer, `pnl_${symbol}.jpg`), { reply_markup: kb });
  } catch (imgErr) {
    console.warn("PNL card failed:", imgErr.message);
    const isUp  = mcapNow >= mcapThen;
    const sign  = isUp ? "+" : "";
    let msg = `📊 <b>PNL — ${t.name} (${symbol})</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `⏱ <b>Last checked:</b> ${timeSince(snap.timestamp)}\n\n`;
    msg += `📊 <b>MCap then:</b>  <code>$${fmtNum(mcapThen)}</code>\n`;
    msg += `📊 <b>MCap now:</b>   <code>$${fmtNum(mcapNow)}</code>\n\n`;
    msg += `${isUp ? "📈" : "📉"} <b>Change:</b>  ${isUp ? "🟢" : "🔴"} <code>${sign}${pctChange.toFixed(2)}%</code>`;
    if (Math.abs(xChange - 1) >= 0.1) msg += `  |  <b>${sign}${xChange.toFixed(2)}x</b>`;
    msg += `\n\n<i>Snapshot: ${fmtDateTime(snap.timestamp)}</i>`;
    await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
  }
});

// ─── /devcheck ────────────────────────────────────────────────────────────────

bot.command("devcheck", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /devcheck <SYMBOL>");
  const loading = await ctx.reply(`⏳ Analysing dev wallet for <b>${symbol}</b>…\n<i>This may take a few seconds</i>`, { parse_mode: "HTML" });
  try {
    const result = await buildDevCheckMsg(symbol);
    if (result.error) return ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ ${result.error}`, { parse_mode: "HTML" });
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, result.msg, { parse_mode: "HTML", reply_markup: result.kb });
  } catch (e) {
    console.error("devcheck error:", e);
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ Error running dev check.`);
  }
});

async function buildDevCheckMsg(symbol) {
  const r = await runDevCheck(symbol);
  if (r.error) return { error: r.error };
  let msg = `🕵️ <b>Dev Check — ${r.tokenName} (${r.symbol})</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `👤 <b>Creator:</b> <code>${r.creator}</code>\n\n`;
  msg += `💼 <b>Current Holdings</b>\n`;
  if (!r.balanceKnown) {
    msg += `   Balance: <code>⚪ Not in top 500 holders</code>\n   Status:  ❓ Unable to confirm\n\n`;
  } else if (r.currentBalance > 0) {
    const holdingEmoji = r.holdingPct >= 10 ? "🔴" : r.holdingPct >= 5 ? "🟡" : "🟢";
    msg += `   Balance: <code>${fmtNum(r.currentBalance)} ${r.symbol}</code>\n`;
    msg += `   Share:   ${holdingEmoji} <code>${r.holdingPct.toFixed(2)}%</code>\n`;
    msg += `   Value:   <code>~$${fmtNum(r.valueUsd)}</code>\n   Status:  🟢 Still Holding\n\n`;
  } else {
    msg += `   Balance: <code>0 ${r.symbol}</code>\n   Status:  🔴 Dev fully exited\n\n`;
  }
  msg += `📤 <b>Sell Activity</b>\n`;
  if (r.totalSold > 0) {
    const soldPct = r.totalSupply > 0 ? (r.totalSold / r.totalSupply * 100).toFixed(2) : "?";
    msg += `   Total Sold: <code>${fmtNum(r.totalSold)} ${r.symbol}</code> (${soldPct}%)\n`;
    msg += `   Sell Txns:  ${r.sellCount}\n`;
    if (r.lastSell?.timestamp) msg += `   Last Sell:  ${fmtDateTime(r.lastSell.timestamp)}\n`;
  } else {
    msg += `   Total Sold: 0 — never sold ✅\n`;
  }
  msg += `\n`;
  if (r.suspiciousTransfers?.length > 0) {
    msg += `🔀 <b>Token Transfers to Other Wallets</b>\n`;
    for (const w of r.suspiciousTransfers.slice(0, 5)) {
      msg += `   → <code>${w.to}</code>${w.isFresh ? " ⚠️ <i>fresh wallet</i>" : ""}\n      ${fmtNum(w.amount)} ${r.symbol}\n`;
    }
    msg += `\n`;
  } else {
    msg += `🔀 <b>Wallet Transfers:</b> None detected ✅\n\n`;
  }
  if (r.flags?.length > 0) { msg += `⚠️ <b>Risk Flags</b>\n`; for (const f of r.flags) msg += `   ${f}\n`; msg += `\n`; }
  if (r.positive?.length > 0) { msg += `✅ <b>Positive Signals</b>\n`; for (const p of r.positive) msg += `   ${p}\n`; msg += `\n`; }
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `${r.riskEmoji} <b>Risk Score: ${r.riskScore}/10 — ${r.riskLabel}</b>\n`;
  msg += `<code>${"█".repeat(r.riskScore)}${"░".repeat(10 - r.riskScore)}</code>\n\n`;
  msg += `<i>⚠️ Always DYOR. Not financial advice.</i>\n<i>Source: dex.protonnz.com · XPR Network</i>`;
  const kb = new InlineKeyboard().text("🔄 Refresh", `devcheck:${symbol}`).text("📋 Token Info", `token:${symbol}`);
  return { msg, kb };
}

// ─── Inline callbacks ─────────────────────────────────────────────────────────

bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery();
  const [action, symbol] = ctx.callbackQuery.data.split(":");

  if (action === "token") {
    const result = await buildTokenMsg(symbol);
    if (!result) return ctx.answerCallbackQuery("Token not found");
    saveSnapshot(ctx.from.id, symbol, result.token.mcap ?? result.token.price);
    await ctx.editMessageText(result.msg, { parse_mode: "HTML", reply_markup: result.kb })
      .catch(() => ctx.reply(result.msg, { parse_mode: "HTML", reply_markup: result.kb }));

  } else if (action === "price") {
    const t = await getToken(symbol);
    if (!t) return ctx.answerCallbackQuery("No data found");
    saveSnapshot(ctx.from.id, symbol, t.mcap ?? t.price);
    const kb = new InlineKeyboard().text("📋 Full Info", `token:${symbol}`).text("🔄 Refresh", `price:${symbol}`);
    await ctx.editMessageText(
      `💰 <b>${t.name}</b> (<code>${t.symbol}</code>)\n\nPrice:  <code>${fmtPrice(t.price)}</code>\nMCap:   <code>$${fmtNum(t.mcap)}</code>\n24h:    ${fmtChange(t.change24h)}\nStatus: ${bondStatus(t)}\n\n<i>dex.protonnz.com</i>`,
      { parse_mode: "HTML", reply_markup: kb }
    ).catch(() => {});

  } else if (action === "trades") {
    const trades = await getTrades(symbol, 5);
    if (!trades.length) return ctx.reply(`❌ No recent trades for <b>${symbol}</b>`, { parse_mode: "HTML" });
    let msg = `🔄 <b>Recent ${symbol} Trades</b>\n\n`;
    for (const t of trades) {
      msg += `${t.type === "buy" ? "🟢 BUY " : "🔴 SELL"}  ${fmtPrice(t.price)}  ×${fmtNum(t.amount)}\n`;
      msg += `   👤 <code>${t.account ?? "unknown"}</code>  🕐 ${fmtTime(t.timestamp)}\n\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML" });

  } else if (action === "holders") {
    const holders = await getHolders(symbol, 10);
    if (!holders.length) return ctx.reply(`❌ No holder data for <b>${symbol}</b>.`, { parse_mode: "HTML" });
    const tokenInfo = await getToken(symbol);
    const supply = tokenInfo?.circulatingSupply ?? tokenInfo?.supply ?? 0;
    let msg = `👥 <b>${symbol} Top Holders</b>\n\n`;
    holders.forEach((h, i) => {
      const total = parseFloat(h.walletAmount ?? h.amount ?? 0) + parseFloat(h.lpAmount ?? 0);
      const pct   = supply > 0 ? (total / supply * 100) : 0;
      msg += `${i + 1}. <code>${h.account ?? "unknown"}</code>\n   💼 ${fmtNum(total)} ${symbol}`;
      if (pct > 0) msg += `  <b>(${pct.toFixed(2)}%)</b>`;
      msg += `\n\n`;
    });
    msg += `<i>Source: dex.protonnz.com</i>`;
    await ctx.reply(msg, { parse_mode: "HTML" });

  } else if (action === "devcheck") {
    await ctx.editMessageText(`⏳ Refreshing dev check for <b>${symbol}</b>…`, { parse_mode: "HTML" }).catch(() => {});
    const result = await buildDevCheckMsg(symbol);
    if (result.error) return ctx.editMessageText(`❌ ${result.error}`).catch(() => {});
    await ctx.editMessageText(result.msg, { parse_mode: "HTML", reply_markup: result.kb })
      .catch(() => ctx.reply(result.msg, { parse_mode: "HTML", reply_markup: result.kb }));
  }
});

// ─── /launch ──────────────────────────────────────────────────────────────────

bot.command("launch", async (ctx) => {
  const arg = ctx.match?.trim().toLowerCase();
  if (arg === "stop" || arg === "off" || arg === "unsubscribe") {
    unsubscribeFromLaunches(ctx.chat.id);
    return ctx.reply(`🔕 <b>Launch notifications off.</b>`, { parse_mode: "HTML" });
  }
  if (isSubscribedToLaunches(ctx.chat.id)) {
    return ctx.reply(`✅ <b>Already subscribed!</b>\n\nUse <code>/launch stop</code> to unsubscribe.`, { parse_mode: "HTML" });
  }
  subscribeToLaunches(ctx.chat.id);
  await ctx.reply(
    `🚀 <b>Launch alerts ON!</b>\n\nYou'll be notified when new tokens launch on <a href="https://dex.protonnz.com">dex.protonnz.com</a>\n\nUse <code>/launch stop</code> to unsubscribe.`,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

// ─── /wallet ──────────────────────────────────────────────────────────────────

bot.command("wallet", async (ctx) => {
  const arg    = ctx.match?.trim();
  const argLow = arg?.toLowerCase();

  if (!argLow || argLow === "status") {
    const wallet = await getWallet(ctx.from.id);
    if (wallet) {
      return ctx.reply(
        `💼 <b>Your Trading Wallet</b>\n\n📬 Account: <code>${wallet.accountName}</code>\n🔑 Public Key: <code>${wallet.publicKey}</code>\n\n` +
        `⚙️ Auto-buy:  ${wallet.autoBuyEnabled ? `✅ ${wallet.autoBuyXpr} XPR/trade` : "❌ Off"}\n` +
        `⚙️ Auto-sell: ${wallet.autoSellEnabled ? `✅ ${wallet.autoSellX}x target` : "❌ Off"}\n\n` +
        `/wallet address — deposit address\n/wallet remove — disconnect\n/balance — check balance`,
        { parse_mode: "HTML" }
      );
    }
    return ctx.reply(
      `👋 <b>XPR Radar Trading</b>\n\nConnect your WebAuth wallet:\n<code>/wallet import &lt;privatekey&gt; &lt;accountname&gt;</code>\n\nWebAuth → Settings → Backup Wallet → Show Private Key`,
      { parse_mode: "HTML" }
    );
  }

  if (argLow === "address") {
    const wallet = await getWallet(ctx.from.id);
    if (!wallet) return ctx.reply("❌ No wallet connected. Use /wallet import first.");
    return ctx.reply(`📬 <b>Trading Wallet</b>\n\nAccount: <code>${wallet.accountName}</code>\n\nSend XPR to this account name.`, { parse_mode: "HTML" });
  }

  if (argLow === "remove") {
    const wallet = await getWallet(ctx.from.id);
    if (!wallet) return ctx.reply("❌ No wallet connected.");
    await removeWallet(ctx.from.id);
    return ctx.reply(`✅ <b>Wallet disconnected.</b>\n\n<code>${wallet.accountName}</code> removed. Funds are safe in WebAuth.`, { parse_mode: "HTML" });
  }

  if (argLow?.startsWith("import")) {
    if (ctx.chat.type !== "private") {
      return ctx.reply(`🔒 <b>Private chat only!</b>\n\nOpen a private chat with the bot for security.`, { parse_mode: "HTML" });
    }

    const parts       = arg.trim().split(/\s+/);
    const privateKey  = parts[1];
    const accountName = parts[2]?.toLowerCase();

    if (!privateKey || !accountName) {
      return ctx.reply(
        `🔑 <b>Import Your WebAuth Wallet</b>\n\n<b>Usage:</b>\n<code>/wallet import &lt;privatekey&gt; &lt;accountname&gt;</code>\n\nWebAuth → Settings → Backup Wallet → Show Private Key\n\n⚠️ Message will be <b>immediately deleted</b>.`,
        { parse_mode: "HTML" }
      );
    }

    const existing = await getWallet(ctx.from.id);
    if (existing) {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      return ctx.reply(`✅ Wallet already connected: <code>${existing.accountName}</code>\n\nUse /wallet remove first.`, { parse_mode: "HTML" });
    }

    if (!isValidPrivateKey(privateKey)) {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      return ctx.reply(
        `❌ <b>Invalid private key format.</b>\n\nExpected a key starting with <code>5</code> (WIF) or <code>PVT_K1_</code> (WebAuth).\n\nGo to WebAuth → Settings → Backup Wallet → Show Private Key.\n\nMessage deleted for security.`,
        { parse_mode: "HTML" }
      );
    }

    await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
    const loading = await ctx.reply(`⏳ Verifying key for <code>${accountName}</code>…`, { parse_mode: "HTML" });

    try {
      const result = await importWallet(ctx.from.id, privateKey, accountName);
      if (result.error === "already_exists") {
        return ctx.api.editMessageText(ctx.chat.id, loading.message_id, `✅ Wallet already connected: <code>${result.accountName}</code>`, { parse_mode: "HTML" });
      }
      if (result.error === "key_mismatch") {
        return ctx.api.editMessageText(ctx.chat.id, loading.message_id,
          `❌ <b>Key verification failed</b>\n\n${result.message}\n\nMake sure you're using the correct private key for <code>${accountName}</code>.`,
          { parse_mode: "HTML" });
      }
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
        `✅ <b>Wallet Connected!</b>\n\n📬 Account: <code>${result.accountName}</code>\n🔑 Public Key: <code>${result.pubKey}</code>\n\n🗑 Private key message deleted.\n\n/autobuy 5 — auto-buy 5 XPR on every launch\n/autosell 3 — auto-sell at 3x\n/balance — check balance`,
        { parse_mode: "HTML" });
    } catch (e) {
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ Import failed: ${e.message}`).catch(() => {});
    }
    return;
  }

  await ctx.reply(`Unknown wallet command.\n/wallet — status\n/wallet import — connect\n/wallet address — deposit\n/wallet remove — disconnect`, { parse_mode: "HTML" });
});

// ─── /balance ─────────────────────────────────────────────────────────────────

bot.command("balance", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply(`❌ No wallet found.\n\nUse /wallet import to connect.`, { parse_mode: "HTML" });

  const loading = await ctx.reply("⏳ Checking balance…");

  const [xpr, positions, holdings] = await Promise.all([
    getXprBalance(wallet.accountName),
    getOpenPositions(ctx.from.id).catch(() => []),
    getAllHoldings(wallet.accountName).catch(() => []),
  ]);

  let msg = `💼 <b>Wallet Balance</b>\n\n`;
  msg += `📬 Account: <code>${wallet.accountName}</code>\n`;
  msg += `💰 XPR:     <code>${xpr.toFixed(4)} XPR</code>\n\n`;

  if (holdings.length) {
    msg += `🪙 <b>Bonding Curve Holdings</b>\n`;
    for (const h of holdings) {
      const pos          = positions.find(p => String(p.tokenId) === String(h.tokenId));
      const label        = pos ? pos.symbol : `tokenId:${h.tokenId}`;
      const currentToken = pos ? await getToken(pos.symbol).catch(() => null) : null;
      const currentMcap  = currentToken?.mcap ?? 0;
      const xMultiple    = pos?.entryMcap > 0 ? currentMcap / pos.entryMcap : 0;
      const pnlEmoji     = xMultiple >= 1 ? "🟢" : xMultiple > 0 ? "🔴" : "";
      msg += `   ${pnlEmoji} <b>${label}</b> — <code>${fmtNum(h.amount)}</code> tokens`;
      if (xMultiple > 0) msg += ` · ${xMultiple.toFixed(2)}x`;
      msg += `\n`;
      if (pos) msg += `      Spent: <code>${pos.xprSpent} XPR</code> · MCap: <code>$${fmtNum(currentMcap)}</code>\n`;
    }
    msg += `\n`;
  } else if (positions.length) {
    msg += `📊 <b>Open Positions (${positions.length})</b>\n`;
    for (const p of positions) msg += `   • ${p.symbol} — ${p.xprSpent} XPR spent\n`;
    msg += `\n`;
  }

  msg += `⚙️ Auto-buy:  ${wallet.autoBuyEnabled  ? `✅ ${wallet.autoBuyXpr} XPR/trade` : "❌ Off"}\n`;
  msg += `⚙️ Auto-sell: ${wallet.autoSellEnabled ? `✅ ${wallet.autoSellX}x target`    : "❌ Off"}\n`;
  msg += `⚙️ Stop-loss: ${wallet.autoSellEnabled ? `✅ ${Math.round((1 - (wallet.autoSellSL || 0.6)) * 100)}% drop` : "❌ Off"}`;

  await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, { parse_mode: "HTML" });
});

// ─── /autobuy ─────────────────────────────────────────────────────────────────

bot.command("autobuy", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet import first.");
  const arg = ctx.match?.trim().toLowerCase();
  if (arg === "off" || arg === "stop") {
    await updateWalletSettings(ctx.from.id, { autoBuyEnabled: false });
    return ctx.reply("🔴 <b>Auto-buy disabled.</b>", { parse_mode: "HTML" });
  }
  const amount = parseFloat(arg);
  if (!amount || amount <= 0) {
    return ctx.reply(`⚙️ <b>Auto-Buy</b>\n\nCurrent: ${wallet.autoBuyEnabled ? `✅ ${wallet.autoBuyXpr} XPR/trade` : "❌ Off"}\n\nSet: /autobuy 5\nOff: /autobuy off`, { parse_mode: "HTML" });
  }
  await updateWalletSettings(ctx.from.id, { autoBuyEnabled: true, autoBuyXpr: amount });
  await ctx.reply(`✅ <b>Auto-buy enabled!</b>\n\nAmount: <code>${amount} XPR</code> per new launch\nUse /autobuy off to disable.`, { parse_mode: "HTML" });
});

// ─── /autosell ────────────────────────────────────────────────────────────────

bot.command("autosell", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet import first.");
  const arg = ctx.match?.trim().toLowerCase();
  if (arg === "off" || arg === "stop") {
    await updateWalletSettings(ctx.from.id, { autoSellEnabled: false });
    return ctx.reply("🔴 <b>Auto-sell disabled.</b>", { parse_mode: "HTML" });
  }
  const multiplier = parseFloat(arg);
  if (!multiplier || multiplier <= 1) {
    return ctx.reply(`⚙️ <b>Auto-Sell</b>\n\nCurrent: ${wallet.autoSellEnabled ? `✅ Sell at ${wallet.autoSellX}x` : "❌ Off"}\n\nSet: /autosell 3\nOff: /autosell off`, { parse_mode: "HTML" });
  }
  await updateWalletSettings(ctx.from.id, { autoSellEnabled: true, autoSellX: multiplier });
  await ctx.reply(`✅ <b>Auto-sell enabled!</b>\n\nTarget: <code>${multiplier}x</code> from entry mcap\nUse /autosell off to disable.`, { parse_mode: "HTML" });
});

// ─── /stoploss ────────────────────────────────────────────────────────────────

bot.command("stoploss", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet import first.");
  const dropPct = parseFloat(ctx.match?.trim());
  if (isNaN(dropPct) || dropPct <= 0 || dropPct >= 100) {
    const currentSL = wallet.autoSellSL || 0.6;
    return ctx.reply(`⚙️ <b>Stop-Loss</b>\n\nCurrent: <code>${Math.round((1 - currentSL) * 100)}%</code> drop\n\nSet: /stoploss 50 (sell if down 50%)`, { parse_mode: "HTML" });
  }
  const slMultiple = (100 - dropPct) / 100;
  await updateWalletSettings(ctx.from.id, { autoSellSL: slMultiple });
  await ctx.reply(`✅ <b>Stop-loss updated!</b>\n\nNew trades will sell if they drop <code>${dropPct}%</code> from entry.`, { parse_mode: "HTML" });
});

// ─── /sl <SYMBOL> <PERCENT> ──────────────────────────────────────────────────

bot.command("sl", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet import first.");
  const parts   = ctx.match?.trim().toUpperCase().split(/\s+/);
  const symbol  = parts?.[0];
  const dropPct = parseFloat(parts?.[1]);
  if (!symbol || isNaN(dropPct)) {
    return ctx.reply(`⚙️ <b>Update Stop-Loss for a Trade</b>\n\n<b>Usage:</b> /sl &lt;SYMBOL&gt; &lt;PERCENT&gt;\n<b>Example:</b> <code>/sl MARSH 50</code>`, { parse_mode: "HTML" });
  }
  const slMultiple = (100 - dropPct) / 100;
  const success    = await updatePositionSL(ctx.from.id, symbol, slMultiple);
  if (!success) return ctx.reply(`❌ No open position for <b>${symbol}</b>.`, { parse_mode: "HTML" });
  await ctx.reply(`✅ <b>Stop-loss updated for ${symbol}!</b>\n\nWill sell if it drops <code>${dropPct}%</code> from entry.`, { parse_mode: "HTML" });
});

// ─── /positions ───────────────────────────────────────────────────────────────

bot.command("positions", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet import first.");

  const positions = await getOpenPositions(ctx.from.id);
  if (!positions.length) {
    return ctx.reply(`📊 <b>No open positions.</b>\n\nEnable auto-buy with /autobuy 5 to start trading.`, { parse_mode: "HTML" });
  }

  let msg = `📊 <b>Open Positions (${positions.length})</b>\n\n`;

  for (const p of positions) {
    const token       = await getToken(p.symbol).catch(() => null);
    const currentMcap = token?.mcap ?? 0;
    const xMultiple   = p.entryMcap > 0 ? currentMcap / p.entryMcap : 0;
    const pnlEmoji    = xMultiple >= 1 ? "🟢" : "🔴";

    // Format buy time — openedAt can be unix timestamp (number) or Date
    let buyTimeStr = "—";
    if (p.openedAt) {
      buyTimeStr = timeSince(
        typeof p.openedAt === "number" ? p.openedAt :
        typeof p.openedAt === "string" ? Math.floor(new Date(p.openedAt).getTime() / 1000) :
        Math.floor(new Date(p.openedAt).getTime() / 1000)
      );
    }

    msg += `${pnlEmoji} <b>${p.symbol}</b>\n`;
    msg += `   Bought:  <code>${buyTimeStr}</code>\n`;
    msg += `   Spent:   <code>${p.xprSpent} XPR</code>\n`;
    msg += `   Entry:   <code>$${fmtNum(p.entryMcap)}</code> mcap\n`;
    msg += `   Current: <code>$${fmtNum(currentMcap)}</code> mcap\n`;
    msg += `   P/L:     <code>${xMultiple.toFixed(2)}x</code>\n`;
    msg += `   Target:  <code>${p.autoSellX}x</code>  SL: <code>${Math.round((1 - (p.autoSellSL || 0.6)) * 100)}%</code> drop\n\n`;
  }

  await ctx.reply(msg, { parse_mode: "HTML" });
});

// ─── /history ─────────────────────────────────────────────────────────────────

bot.command("history", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet import first.");
  const trades = await getTradeHistory(ctx.from.id, 10);
  if (!trades.length) return ctx.reply("📜 No trade history yet.", { parse_mode: "HTML" });
  let msg = `📜 <b>Trade History (last ${trades.length})</b>\n\n`;
  let totalPnl = 0;
  for (const t of trades) {
    totalPnl += t.pnlXpr ?? 0;
    msg += `${t.pnlXpr >= 0 ? "✅" : "❌"} <b>${t.symbol}</b> — <code>${t.xMulti?.toFixed(2) ?? "?"}x</code>\n`;
    msg += `   PNL: <code>${t.pnlXpr >= 0 ? "+" : ""}${t.pnlXpr?.toFixed(4)} XPR</code>\n\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━━━━\nTotal PNL: <code>${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} XPR</code>`;
  await ctx.reply(msg, { parse_mode: "HTML" });
});

// ─── /quote ───────────────────────────────────────────────────────────────────

bot.command("quote", async (ctx) => {
  const parts  = ctx.match?.trim().toUpperCase().split(/\s+/);
  const symbol = parts?.[0];
  const xprAmt = parseFloat(parts?.[1]);
  if (!symbol || !xprAmt || xprAmt <= 0) return ctx.reply("Usage: /quote SYMBOL AMOUNT\nExample: /quote MARSH 5");
  const loading = await ctx.reply(`⏳ Getting quote for ${symbol}…`);
  const token   = await getToken(symbol);
  if (!token) return ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ Token ${symbol} not found.`);
  if (token.graduated) return ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ ${symbol} has graduated — not on bonding curve.`);
  const price       = token.price ?? 0;
  const estTokens   = price > 0 ? xprAmt / price : 0;
  const xprUsd      = xprAmt * 0.00035;
  const priceImpact = token.mcap > 0 ? (xprUsd / token.mcap) * 100 : 0;
  await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
    `📊 <b>Quote — ${token.name} (${symbol})</b>\n\n` +
    `💰 You spend:     <code>${xprAmt} XPR</code>\n` +
    `🪙 You receive:   <code>~${fmtNum(estTokens)} ${symbol}</code>\n` +
    `📈 Price impact:  <code>~${priceImpact.toFixed(2)}%</code>\n` +
    `📊 Current MCap:  <code>$${fmtNum(token.mcap)}</code>\n` +
    `💵 Current price: <code>${fmtPrice(price)}</code>\n\n` +
    `<i>Estimate only. To execute: /buy ${symbol} ${xprAmt}</i>`,
    { parse_mode: "HTML" });
});

// ─── /buy ─────────────────────────────────────────────────────────────────────

bot.command("buy", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet import first.");
  const parts  = ctx.match?.trim().toUpperCase().split(/\s+/);
  const symbol = parts?.[0];
  const xprAmt = parseFloat(parts?.[1]);
  if (!symbol || !xprAmt || xprAmt <= 0) return ctx.reply(`Usage: /buy SYMBOL AMOUNT\nExample: /buy MARSH 5`, { parse_mode: "HTML" });

  const token = await getToken(symbol);
  if (!token) return ctx.reply(`❌ Token ${symbol} not found.`);
  if (token.graduated) return ctx.reply(`❌ ${symbol} is graduated — not on bonding curve.`);

  const balance = await getXprBalance(wallet.accountName);
  if (balance < xprAmt) return ctx.reply(`❌ Insufficient balance.\nNeed: <code>${xprAmt} XPR</code>\nHave: <code>${balance.toFixed(4)} XPR</code>`, { parse_mode: "HTML" });

  const loading = await ctx.reply(`⏳ Buying ${symbol}…`);
  try {
    await buyTokens({ userId: ctx.from.id, accountName: wallet.accountName, tokenId: token.tokenId, xprAmount: xprAmt });

    const precision = await getTokenPrecision(symbol).catch(() => 4);
    const boughtAt  = Math.floor(Date.now() / 1000);

    // Auto-save PNL snapshot at buy time
    saveSnapshot(ctx.from.id, symbol, token.mcap ?? 0);

    await openPosition({
      userId: ctx.from.id, accountName: wallet.accountName,
      symbol: token.symbol, tokenId: token.tokenId,
      tokenName: token.name, xprSpent: xprAmt,
      tokenAmount: 0, entryMcap: token.mcap ?? 0,
      autoSellX:  wallet.autoSellX,
      autoSellSL: wallet.autoSellSL || 0.6,
      precision,
      openedAt: boughtAt,
    });

    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `✅ <b>Bought ${symbol}!</b>\n\n` +
      `💰 Spent:  <code>${xprAmt} XPR</code>\n` +
      `📊 MCap:   <code>$${fmtNum(token.mcap)}</code>\n` +
      `🎯 Target: <code>${wallet.autoSellX}x</code>\n\n` +
      `Use /positions to track. Use /pnl ${symbol} to see gain/loss.`,
      { parse_mode: "HTML" });
  } catch (e) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ Buy failed: ${e.message}`).catch(() => {});
  }
});

// ─── /sell ────────────────────────────────────────────────────────────────────

bot.command("sell", async (ctx) => {
  const wallet = await getWallet(ctx.from.id);
  if (!wallet) return ctx.reply("❌ No wallet. Use /wallet import first.");
  const parts  = ctx.match?.trim().toUpperCase().split(/\s+/);
  const symbol = parts?.[0];
  if (!symbol) return ctx.reply("Usage: /sell SYMBOL\nExample: /sell MARSH");

  const token    = await getToken(symbol);
  if (!token) return ctx.reply(`❌ Token ${symbol} not found.`);
  const position = await getPosition(ctx.from.id, symbol);
  if (!position) return ctx.reply(`❌ No open position for ${symbol}.`);

  const loading = await ctx.reply(`⏳ Selling ${symbol}…`);
  try {
    const txResult = await sellTokens({
      userId:      ctx.from.id,
      accountName: wallet.accountName,
      tokenId:     token.tokenId,
      tokenAmount: position.tokenAmount,
      symbol,
      precision:   position.precision || 4,
    });

    const currentMcap = token.mcap ?? 0;
    const xMultiple   = position.entryMcap > 0 ? currentMcap / position.entryMcap : 1;
    const xprReceived = position.xprSpent * xMultiple;
    const txId        = txResult?.transaction_id?.slice(0, 16) ?? "confirmed";
    const closed      = await closePosition({ userId: ctx.from.id, symbol, xprReceived });

    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `✅ <b>Sold ${symbol}!</b>\n\n` +
      `📈 Multiple:  <code>${xMultiple.toFixed(2)}x</code>\n` +
      `💰 Spent:     <code>${position.xprSpent.toFixed(4)} XPR</code>\n` +
      `💵 Received:  <code>${xprReceived.toFixed(4)} XPR</code>\n` +
      `📊 PNL:       <code>${closed.pnlXpr >= 0 ? "+" : ""}${closed.pnlXpr.toFixed(4)} XPR</code>\n` +
      `🔗 TX:        <code>${txId}…</code>`,
      { parse_mode: "HTML" });
  } catch (e) {
    console.error("Manual sell error:", e.message);
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, `❌ Sell failed: ${e.message}`).catch(() => {});
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

bot.catch((err) => console.error("Bot error:", err.message));
console.log("🚀 XPR Radar Bot starting...");
startLaunchNotifier(bot);
registerAutoBuyHandler(autoBuyNewToken);
startPositionMonitor(bot);
startDepositMonitor(bot);
bot.start();