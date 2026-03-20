import { Bot, InlineKeyboard } from "grammy";
import { getTokenPool, getTokenMetadata, getAllPools, getRecentTrades } from "./xprApi.js";
import "dotenv/config";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const bot = new Bot(BOT_TOKEN);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(n) {
  if (!n || n === 0) return "0";
  if (n >= 1000)   return n.toLocaleString("en", { maximumFractionDigits: 2 });
  if (n >= 1)      return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toFixed(10);
}

function fmtNum(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)         return n.toLocaleString("en", { maximumFractionDigits: 2 });
  return n.toFixed(2);
}

function bondedStatus(pool) {
  if (!pool) return "❓ Unknown";
  // On XPR AMMs, a pool existing at all means it's launched.
  // "bonded" typically means liquidity is locked / permanent.
  if (pool.bonded === true  || pool.bonded === 1)  return "✅ Bonded";
  if (pool.bonded === false || pool.bonded === 0)  return "🔓 Not Bonded";
  if (pool.lpSupply > 0) return "✅ Has Liquidity";
  return "❓ Unknown";
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await ctx.reply(
    `👋 <b>SimpleDEX Info Bot</b>\n\n` +
    `Get token info from <a href="https://dex.protonnz.com">dex.protonnz.com</a> on XPR Network.\n\n` +
    `<b>Commands:</b>\n` +
    `/token &lt;SYMBOL&gt; — Full token info\n` +
    `/price &lt;SYMBOL&gt; — Quick price check\n` +
    `/tokens — List all tokens on the DEX\n` +
    `/trades &lt;SYMBOL&gt; — Recent swaps\n` +
    `/help — Show this message`,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    `<b>SimpleDEX Info Bot — Commands</b>\n\n` +
    `🔍 /token XPR — Full token metadata\n` +
    `   • Current price\n` +
    `   • Market cap (if supply available)\n` +
    `   • Pool reserves\n` +
    `   • Bonded status\n` +
    `   • Liquidity info\n\n` +
    `💰 /price XPR — Quick price only\n\n` +
    `🪙 /tokens — All tokens listed on SimpleDEX\n\n` +
    `🔄 /trades XPR — Last 5 swaps for a token\n\n` +
    `<i>Example: /token METAL</i>`,
    { parse_mode: "HTML" }
  );
});

// ─── /token — Full metadata ───────────────────────────────────────────────────

bot.command("token", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) {
    return ctx.reply("Usage: /token <SYMBOL>\nExample: /token XPR");
  }

  const loading = await ctx.reply(`⏳ Fetching info for <b>${symbol}</b>…`, { parse_mode: "HTML" });

  try {
    const [pool, meta] = await Promise.all([
      getTokenPool(symbol),
      getTokenMetadata(symbol),
    ]);

    if (!pool && !meta.stats) {
      await ctx.api.editMessageText(
        ctx.chat.id, loading.message_id,
        `❌ <b>${symbol}</b> not found on SimpleDEX.\n\nUse /tokens to see all listed tokens.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    // Supply & market cap from on-chain token stats
    let supply = null;
    let maxSupply = null;
    let issuer = null;

    if (meta.stats) {
      const s = parseAsset(meta.stats.supply ?? "");
      const ms = parseAsset(meta.stats.max_supply ?? "");
      supply    = s.amount > 0 ? s.amount : null;
      maxSupply = ms.amount > 0 ? ms.amount : null;
      issuer    = meta.stats.issuer ?? null;
    }

    // Market cap = price × circulating supply
    const price = pool?.price ?? null;
    const marketCap = price && supply ? price * supply : null;

    // Build message
    let msg = `🪙 <b>${symbol}</b> — Token Info\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Price section
    if (price) {
      msg += `💰 <b>Price</b>\n`;
      msg += `   1 ${symbol} = <code>${fmtPrice(price)}</code> ${pool.quoteToken}\n\n`;
    } else {
      msg += `💰 <b>Price:</b> Not available\n\n`;
    }

    // Market cap
    if (marketCap) {
      msg += `📊 <b>Market Cap</b>\n`;
      msg += `   ~${fmtNum(marketCap)} ${pool.quoteToken}\n\n`;
    }

    // Supply
    if (supply) {
      msg += `🏭 <b>Circulating Supply:</b> ${fmtNum(supply)}\n`;
      if (maxSupply) msg += `📦 <b>Max Supply:</b> ${fmtNum(maxSupply)}\n`;
      msg += `\n`;
    }

    // Bonded / liquidity status
    msg += `🔗 <b>Bond Status:</b> ${bondedStatus(pool)}\n\n`;

    // Pool info
    if (pool) {
      msg += `🏦 <b>Pool (${pool.token0}/${pool.token1})</b>\n`;
      msg += `   Reserve ${pool.token0}: <code>${fmtNum(pool.reserve0)}</code>\n`;
      msg += `   Reserve ${pool.token1}: <code>${fmtNum(pool.reserve1)}</code>\n`;
      if (pool.lpSupply > 0) msg += `   LP Supply: <code>${fmtNum(pool.lpSupply)}</code>\n`;
      msg += `   Swap Fee: ${(pool.fee * 100).toFixed(2)}%\n\n`;
    }

    // Issuer
    if (issuer) msg += `👤 <b>Issuer:</b> <code>${issuer}</code>\n`;
    if (meta.contractName) msg += `📋 <b>Contract:</b> <code>${meta.contractName}</code>\n`;

    msg += `\n<i>Source: dex.protonnz.com · XPR Network</i>`;

    const kb = new InlineKeyboard()
      .text("🔄 Refresh", `token:${symbol}`)
      .text("📜 Trades",  `trades:${symbol}`);

    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, {
      parse_mode: "HTML",
      reply_markup: kb,
    });

  } catch (e) {
    console.error(e);
    await ctx.api.editMessageText(
      ctx.chat.id, loading.message_id,
      `❌ Error fetching data. Please try again.`,
    );
  }
});

// ─── /price — Quick price ─────────────────────────────────────────────────────

bot.command("price", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /price <SYMBOL>\nExample: /price XPR");

  const loading = await ctx.reply(`⏳ Fetching price…`);

  const pool = await getTokenPool(symbol);
  if (!pool) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ No pool found for <b>${symbol}</b>. Use /tokens to see listed tokens.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const kb = new InlineKeyboard()
    .text("📋 Full Info", `token:${symbol}`)
    .text("🔄 Refresh",   `price:${symbol}`);

  await ctx.api.editMessageText(
    ctx.chat.id, loading.message_id,
    `💰 <b>${symbol}</b> Price\n\n` +
    `1 <b>${symbol}</b> = <code>${fmtPrice(pool.price)}</code> ${pool.quoteToken}\n\n` +
    `Pool: ${pool.token0}/${pool.token1}\n` +
    `<i>dex.protonnz.com</i>`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

// ─── /tokens — List all tokens ────────────────────────────────────────────────

bot.command("tokens", async (ctx) => {
  const loading = await ctx.reply("⏳ Loading token list…");
  const pools = await getAllPools();

  if (!pools.length) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id, "❌ Could not fetch token list.");
    return;
  }

  const tokens = [...new Set(pools.flatMap(p => [p.token0, p.token1]))].sort();

  let msg = `🪙 <b>Tokens on SimpleDEX</b> (${tokens.length} total)\n\n`;
  msg += tokens.map(t => `• <code>${t}</code>`).join("\n");
  msg += `\n\n<i>Use /token SYMBOL for details</i>`;

  await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, { parse_mode: "HTML" });
});

// ─── /trades — Recent swaps ───────────────────────────────────────────────────

bot.command("trades", async (ctx) => {
  const symbol = ctx.match?.trim().toUpperCase();
  if (!symbol) return ctx.reply("Usage: /trades <SYMBOL>\nExample: /trades XPR");

  const loading = await ctx.reply(`⏳ Fetching recent ${symbol} trades…`);
  const trades = await getRecentTrades(symbol, 5);

  if (!trades.length) {
    await ctx.api.editMessageText(ctx.chat.id, loading.message_id,
      `❌ No recent trades found for <b>${symbol}</b>.`, { parse_mode: "HTML" }
    );
    return;
  }

  let msg = `🔄 <b>Recent ${symbol} Swaps</b>\n\n`;
  for (const t of trades) {
    const ts = t.timestamp ? t.timestamp.slice(0, 16).replace("T", " ") : "—";
    msg += `👤 <code>${t.trader}</code>\n`;
    msg += `   ${t.amountIn.toFixed(2)} ${t.tokenIn} → ${t.amountOut.toFixed(2)} ${t.tokenOut}\n`;
    msg += `   🕐 ${ts}\n\n`;
  }
  msg += `<i>Source: dex.protonnz.com</i>`;

  await ctx.api.editMessageText(ctx.chat.id, loading.message_id, msg, { parse_mode: "HTML" });
});

// ─── Inline button callbacks ──────────────────────────────────────────────────

bot.on("callback_query:data", async (ctx) => {
  await ctx.answerCallbackQuery();
  const [action, symbol] = ctx.callbackQuery.data.split(":");

  if (action === "token") {
    ctx.match = symbol;
    await bot.handleUpdate({
      ...ctx.update,
      callback_query: undefined,
      message: { ...ctx.callbackQuery.message, text: `/token ${symbol}` },
    });
  } else if (action === "price") {
    ctx.match = symbol;
    // Just re-fetch and edit the existing message
    const pool = await getTokenPool(symbol);
    if (!pool) return ctx.reply(`❌ No pool found for ${symbol}`);
    const kb = new InlineKeyboard()
      .text("📋 Full Info", `token:${symbol}`)
      .text("🔄 Refresh",   `price:${symbol}`);
    await ctx.editMessageText(
      `💰 <b>${symbol}</b> Price\n\n` +
      `1 <b>${symbol}</b> = <code>${fmtPrice(pool.price)}</code> ${pool.quoteToken}\n\n` +
      `Pool: ${pool.token0}/${pool.token1}\n` +
      `<i>dex.protonnz.com</i>`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  } else if (action === "trades") {
    const trades = await getRecentTrades(symbol, 5);
    if (!trades.length) return ctx.reply(`No recent trades for ${symbol}`);
    let msg = `🔄 <b>Recent ${symbol} Swaps</b>\n\n`;
    for (const t of trades) {
      const ts = t.timestamp ? t.timestamp.slice(0, 16).replace("T", " ") : "—";
      msg += `👤 <code>${t.trader}</code>\n`;
      msg += `   ${t.amountIn.toFixed(2)} ${t.tokenIn} → ${t.amountOut.toFixed(2)} ${t.tokenOut}\n`;
      msg += `   🕐 ${ts}\n\n`;
    }
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

bot.catch((err) => console.error("Bot error:", err));

console.log("🚀 SimpleDEX Info Bot starting...");
bot.start();
