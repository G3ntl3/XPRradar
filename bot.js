import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { getToken, getAllTokens, getTrades, getHolders } from "./xprApi.js";
import { runDevCheck } from "./devcheck.js";
import { saveSnapshot, getSnapshot, getUserSnapshots } from "./snapshots.js";

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

function timeSince(ts) {
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60)                    return `${secs}s ago`;
  if (secs < 3600)                  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)                 return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function bondStatus(token) {
  if (token.graduated) return "🎓 Graduated";
  return "📈 On Curve";
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await ctx.reply(
    `👋 <b>XPR Radar</b> — SimpleDEX Token Info Bot\n\n` +
    `Track tokens launched on <a href="https://dex.protonnz.com">dex.protonnz.com</a>\n\n` +
    `<b>Commands:</b>\n` +
    `/token &lt;SYMBOL&gt; — Full token info\n` +
    `/price &lt;SYMBOL&gt; — Quick price\n` +
    `/pnl &lt;SYMBOL&gt; — Price change since you last checked\n` +
    `/trades &lt;SYMBOL&gt; — Recent swaps\n` +
    `/holders &lt;SYMBOL&gt; — Top holders\n` +
    `/devcheck &lt;SYMBOL&gt; — Dev wallet risk check\n` +
    `/tokens — Browse listed tokens\n` +
    `/help — Show commands\n\n` +
    `<i>Try: /token MARSH then come back and run /pnl MARSH</i>`,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    `<b>XPR Radar — Commands</b>\n\n` +
    `🔍 /token MARSH — Full metadata:\n` +
    `   Price · MCap · Supply · Volume\n` +
    `   24h change · Buys/Sells · Holders\n` +
    `   Graduated or On Curve status\n\n` +
    `💰 /price MARSH — Price only\n\n` +
    `📊 /pnl MARSH — Price change since last check\n` +
    `   Auto-tracked every time you use /token or /price\n` +
    `   /pnl with no symbol = see all tracked tokens\n\n` +
    `🔄 /trades MARSH — Recent swaps\n\n` +
    `👥 /holders MARSH — Top holders\n\n` +
    `🪙 /tokens — All tokens on SimpleDEX\n\n` +
    `🕵️ /devcheck MARSH — Dev wallet analysis:\n` +
    `   Is dev still holding?\n` +
    `   Has dev sold? How much?\n` +
    `   Suspicious wallet transfers?\n` +
    `   Risk score 1–10 with flags\n\n` +
    `<i>Data: indexer.protonnz.com</i>`,
    { parse_mode: "HTML" }
  );
});

// ─── /token — Full metadata ───────────────────────────────────────────────────

bot.command("token", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /token <SYMBOL>\nExample: /token MARSH");

  const loading = await ctx.reply(`⏳ Fetching <b>${symbol}</b>…`, { parse_mode: "HTML" });

  try {
    const t = await getToken(symbol);

    if (!t) {
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
        `❌ <b>${symbol}</b> not found on SimpleDEX.\n\nUse /tokens to browse all tokens.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Auto-save price snapshot for /pnl tracking
    saveSnapshot(ctx.from.id, symbol, t.price);

    let msg = "";
    msg += `🪙 <b>${t.name}</b> (<code>${t.symbol}</code>)\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Price & status
    msg += `💰 <b>Price:</b> <code>${fmtPrice(t.price)}</code>\n`;
    msg += `🏷 <b>Status:</b> ${bondStatus(t)}\n\n`;

    // Market stats
    msg += `📊 <b>Market</b>\n`;
    msg += `   MCap:    <code>$${fmtNum(t.mcap)}</code>\n`;
    msg += `   24h Vol: <code>$${fmtNum(t.volume24h)}</code>\n`;
    msg += `   24h:     ${fmtChange(t.change24h)}\n`;
    msg += `   7d:      ${fmtChange(t.change7d)}\n`;
    msg += `   High24h: <code>${fmtPrice(t.high24h)}</code>\n`;
    msg += `   Low24h:  <code>${fmtPrice(t.low24h)}</code>\n\n`;

    // Supply
    msg += `🏭 <b>Supply</b>\n`;
    msg += `   Circulating: <code>${fmtNum(t.circulatingSupply)}</code>\n`;
    msg += `   Total:       <code>${fmtNum(t.supply)}</code>\n`;
    msg += `   Max:         <code>${fmtNum(t.maxSupply)}</code>\n`;
    if (t.burned) msg += `   Burned:      <code>${fmtNum(t.burned)}</code> 🔥\n`;
    msg += `\n`;

    // Trading activity
    msg += `📈 <b>Activity (24h)</b>\n`;
    msg += `   Buys:    ${t.buys24h ?? "—"}\n`;
    msg += `   Sells:   ${t.sells24h ?? "—"}\n`;
    msg += `   Traders: ${t.uniqueTraders24h ?? "—"} unique\n`;
    msg += `   All-time traders: ${t.uniqueTradersAllTime ?? "—"}\n\n`;

    // ATH
    if (t.ath) {
      msg += `🏆 <b>ATH:</b> <code>${fmtPrice(t.ath)}</code>`;
      if (t.athTimestamp) msg += ` (${fmtDate(t.athTimestamp)})`;
      msg += `\n`;
    }

    // Creator & age
    if (t.creator) msg += `👤 <b>Creator:</b> <code>${t.creator}</code>\n`;
    if (t.firstTradeAt) msg += `📅 <b>Launched:</b> ${fmtDate(t.firstTradeAt)}\n`;

    // Description
    if (t.description) {
      const shortDesc = t.description.length > 120
        ? t.description.slice(0, 120) + "…"
        : t.description;
      msg += `\n📝 <i>${shortDesc}</i>\n`;
    }

    msg += `\n<i>Source: dex.protonnz.com</i>`;

    const kb = new InlineKeyboard()
      .text("🔄 Refresh",   `token:${symbol}`)
      .text("🔄 Trades",    `trades:${symbol}`)
      .row()
      .text("👥 Holders",   `holders:${symbol}`);

    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, {
      parse_mode: "HTML",
      reply_markup: kb,
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
  saveSnapshot(ctx.from.id, symbol, t.price);

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
    const time   = t.timestamp ? new Date(t.timestamp * 1000).toISOString().slice(11, 16) + " UTC" : "—";
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

  let msg = `👥 <b>${symbol} Top Holders</b>\n\n`;
  holders.forEach((h, i) => {
    const account = h.account ?? h.holder ?? "unknown";
    const balance = h.balance ?? h.amount ?? 0;
    const pct     = h.percentage ?? h.pct ?? null;
    msg += `${i + 1}. <code>${account}</code>\n`;
    msg += `   ${fmtNum(balance)} ${symbol}`;
    if (pct) msg += `  (${pct.toFixed(2)}%)`;
    msg += `\n\n`;
  });
  msg += `<i>Source: dex.protonnz.com</i>`;

  await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, { parse_mode: "HTML" });
});

// ─── /tokens ──────────────────────────────────────────────────────────────────

bot.command("tokens", async (ctx) => {
  const loading = await ctx.reply("⏳ Loading tokens…");
  const { tokens, count } = await getAllTokens(30);

  if (!tokens.length) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, "❌ Could not fetch token list.");
    return;
  }

  let msg = `🪙 <b>SimpleDEX Tokens</b> (${count} total)\n\n`;
  for (const t of tokens) {
    const status = t.graduated ? "🎓" : "📈";
    msg += `${status} <b>${t.symbol}</b> — ${fmtPrice(t.price)}`;
    msg += ` · MCap $${fmtNum(t.mcap)}\n`;
  }
  msg += `\n<i>Use /token SYMBOL for full details</i>`;

  await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, { parse_mode: "HTML" });
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
      msg += `   Saved price: <code>${fmtPrice(snap.price)}</code>\n\n`;
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

  // Get current price
  const t = await getToken(symbol);
  if (!t) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ Could not fetch current price for <b>${symbol}</b>.`, { parse_mode: "HTML" }
    );
    return;
  }

  const priceThen = snap.price;
  const priceNow  = t.price;
  const pctChange = priceThen > 0 ? ((priceNow - priceThen) / priceThen) * 100 : 0;
  const xChange   = priceThen > 0 ? priceNow / priceThen : 0;
  const ago       = timeSince(snap.timestamp);

  // Direction
  const isUp    = priceNow >= priceThen;
  const arrow   = isUp ? "📈" : "📉";
  const sign    = isUp ? "+" : "";
  const emoji   = isUp ? "🟢" : "🔴";

  // X display — only show if meaningful (>= 1.1x or <= 0.9x)
  let xStr = "";
  if (xChange >= 1.1)       xStr = `  |  <b>+${xChange.toFixed(2)}x</b>`;
  else if (xChange <= 0.9)  xStr = `  |  <b>${xChange.toFixed(2)}x</b>`;

  let msg = `📊 <b>PNL — ${t.name} (${symbol})</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `⏱ <b>Last checked:</b> ${ago}\n\n`;
  msg += `💰 <b>Price then:</b>  <code>${fmtPrice(priceThen)}</code>\n`;
  msg += `💰 <b>Price now:</b>   <code>${fmtPrice(priceNow)}</code>\n\n`;
  msg += `${arrow} <b>Change:</b>  ${emoji} <code>${sign}${pctChange.toFixed(2)}%</code>${xStr}\n\n`;

  // Verdict
  if (Math.abs(pctChange) < 1) {
    msg += `😐 <i>Barely moved since you last checked.</i>\n`;
  } else if (isUp) {
    if (pctChange >= 100)     msg += `🚀 <i>More than doubled since you last checked!</i>\n`;
    else if (pctChange >= 50) msg += `🔥 <i>Strong move up since you last checked.</i>\n`;
    else                      msg += `✅ <i>Up since you last checked.</i>\n`;
  } else {
    if (pctChange <= -50)     msg += `💀 <i>Down over 50% since you last checked.</i>\n`;
    else if (pctChange <= -20) msg += `⚠️ <i>Significant drop since you last checked.</i>\n`;
    else                       msg += `📉 <i>Down since you last checked.</i>\n`;
  }

  msg += `\n<i>Snapshot saved: ${new Date(snap.timestamp * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC</i>`;

  const kb = new InlineKeyboard()
    .text("🔄 Update Snapshot", `price:${symbol}`)
    .text("📋 Token Info",      `token:${symbol}`);

  await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, {
    parse_mode: "HTML",
    reply_markup: kb,
  });
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
    const r = await runDevCheck(symbol);

    if (r.error) {
      await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
        `❌ ${r.error}`, { parse_mode: "HTML" }
      );
      return;
    }

    let msg = "";

    // Header
    msg += `🕵️ <b>Dev Check — ${r.tokenName} (${r.symbol})</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Dev identity
    msg += `👤 <b>Creator:</b> <code>${r.creator}</code>\n\n`;

    // Current holdings
    msg += `💼 <b>Current Holdings</b>\n`;
    if (r.currentBalance > 0) {
      msg += `   Balance: <code>${fmtNum(r.currentBalance)} ${r.symbol}</code>\n`;
      msg += `   Share:   <code>${r.holdingPct.toFixed(2)}%</code> of supply\n`;
      msg += `   Value:   <code>~$${fmtNum(r.valueUsd)}</code>\n`;
      msg += `   Status:  ${r.currentBalance > 0 ? "🟢 Still Holding" : "🔴 Fully Exited"}\n\n`;
    } else {
      msg += `   Balance: <code>0 ${r.symbol}</code>\n`;
      msg += `   Status:  🔴 Dev holds nothing\n\n`;
    }

    // Sell activity
    msg += `📤 <b>Sell Activity</b>\n`;
    if (r.totalSold > 0) {
      const soldPct = r.totalSupply > 0 ? (r.totalSold / r.totalSupply * 100).toFixed(2) : "?";
      msg += `   Total Sold: <code>${fmtNum(r.totalSold)} ${r.symbol}</code> (${soldPct}%)\n`;
      msg += `   Sell Txns:  ${r.sellCount}\n`;
      if (r.lastSell?.timestamp) {
        const ts = new Date(r.lastSell.timestamp * 1000).toISOString().slice(0, 16).replace("T", " ");
        msg += `   Last Sell:  ${ts} UTC\n`;
      }
    } else {
      msg += `   Total Sold: 0 — never sold ✅\n`;
    }
    msg += `\n`;

    // Wallet transfers
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

    // Flags
    if (r.flags.length > 0) {
      msg += `⚠️ <b>Risk Flags</b>\n`;
      for (const f of r.flags) msg += `   ${f}\n`;
      msg += `\n`;
    }

    // Positive signals
    if (r.positive.length > 0) {
      msg += `✅ <b>Positive Signals</b>\n`;
      for (const p of r.positive) msg += `   ${p}\n`;
      msg += `\n`;
    }

    // Risk score
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `${r.riskEmoji} <b>Risk Score: ${r.riskScore}/10 — ${r.riskLabel}</b>\n`;

    // Score bar
    const filled = "█".repeat(r.riskScore);
    const empty  = "░".repeat(10 - r.riskScore);
    msg += `<code>${filled}${empty}</code>\n\n`;

    msg += `<i>⚠️ Always DYOR. This is not financial advice.</i>\n`;
    msg += `<i>Source: dex.protonnz.com · XPR Network</i>`;

    const kb = new InlineKeyboard()
      .text("🔄 Refresh",    `devcheck:${symbol}`)
      .text("📋 Token Info", `token:${symbol}`);

    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, {
      parse_mode: "HTML",
      reply_markup: kb,
    });

  } catch (e) {
    console.error("devcheck error:", e);
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ Error running dev check. Please try again.`
    );
  }
});

// ─── Inline callbacks ─────────────────────────────────────────────────────────

bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery();
  const [action, symbol] = ctx.callbackQuery.data.split(":");

  if (action === "token") {
    ctx.match = symbol;
    await bot.handleUpdate({ ...ctx.update,
      callback_query: undefined,
      message: { ...ctx.callbackQuery.message, text: `/token ${symbol}`, reply_to_message: undefined }
    });

  } else if (action === "price") {
    const t = await getToken(symbol);
    if (!t) return ctx.answerCallbackQuery("No data found");
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
    );

  } else if (action === "trades") {
    const trades = await getTrades(symbol, 5);
    if (!trades.length) return ctx.reply(`No recent trades for ${symbol}`);
    let msg = `🔄 <b>Recent ${symbol} Trades</b>\n\n`;
    for (const t of trades) {
      const type = t.type === "buy" ? "🟢 BUY " : "🔴 SELL";
      const time = t.timestamp ? new Date(t.timestamp * 1000).toISOString().slice(11, 16) + " UTC" : "—";
      msg += `${type}  ${fmtPrice(t.price)}  ×${fmtNum(t.amount)}\n`;
      msg += `   👤 <code>${t.account ?? "unknown"}</code>  🕐 ${time}\n\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML" });

  } else if (action === "holders") {
    const holders = await getHolders(symbol, 10);
    if (!holders.length) return ctx.reply(`No holder data for ${symbol}`);
    let msg = `👥 <b>${symbol} Top Holders</b>\n\n`;
    holders.forEach((h, i) => {
      msg += `${i + 1}. <code>${h.account ?? "unknown"}</code> — ${fmtNum(h.balance ?? 0)}\n`;
    });
    await ctx.reply(msg, { parse_mode: "HTML" });

  } else if (action === "devcheck") {
    await ctx.reply(`⏳ Re-running dev check for <b>${symbol}</b>…`, { parse_mode: "HTML" });
    const r = await runDevCheck(symbol);
    if (r.error) return ctx.reply(`❌ ${r.error}`);

    let msg = `🕵️ <b>Dev Check — ${r.tokenName} (${r.symbol})</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `👤 <b>Creator:</b> <code>${r.creator}</code>\n\n`;
    msg += `💼 Balance: <code>${fmtNum(r.currentBalance)} ${r.symbol}</code> (${r.holdingPct.toFixed(2)}%)\n`;
    msg += `📤 Sold: ${r.totalSold > 0 ? fmtNum(r.totalSold) + " " + r.symbol : "Nothing ✅"}\n`;
    msg += `🔀 Wallet transfers: ${r.suspiciousTransfers.length}\n\n`;
    msg += `${r.riskEmoji} <b>Risk: ${r.riskScore}/10 — ${r.riskLabel}</b>\n`;
    msg += `<code>${"█".repeat(r.riskScore)}${"░".repeat(10 - r.riskScore)}</code>`;

    const kb = new InlineKeyboard()
      .text("🔄 Refresh",    `devcheck:${symbol}`)
      .text("📋 Token Info", `token:${symbol}`);
    await ctx.reply(msg, { parse_mode: "HTML", reply_markup: kb });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

bot.catch((err) => console.error("Bot error:", err.message));
console.log("🚀 XPR Radar Bot starting...");
bot.start();
