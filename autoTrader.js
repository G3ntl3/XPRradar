/**
 * Auto Trader
 * - Auto-buys new tokens for subscribed users on launch
 * - Monitors open positions every 30s, auto-sells at target or stop-loss
 *
 * Uses getBondingBalance() which queries the "holdings" table
 * (scope=accountName, struct: { tokenId, amount }) for real on-chain balances.
 */

import { getAllActiveAutobuyers, getWallet } from "./wallet.js";
import { buyTokens, sellTokens, getXprBalance, getBondingBalance, getAllHoldings } from "./trader.js";
import { openPosition, closePosition, getAllOpenPositions, getPosition } from "./positions.js";
import { getToken } from "./xprApi.js";

const MONITOR_INTERVAL = 30_000; // check positions every 30s

function fmtNum(n) {
  if (!n && n !== 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(2);
}

// ─── Auto-buy a new token for all subscribed users ────────────────────────────

export async function autoBuyNewToken(bot, token) {
  // Only buy on-curve tokens (not graduated)
  if (token.graduated) return;

  const buyers = await getAllActiveAutobuyers();
  if (!buyers.length) return;

  console.log(`🤖 Sniper Mode: Auto-buying ${token.symbol} for ${buyers.length} users in parallel batches`);

  const BATCH_SIZE = 50;
  const chunks = [];
  for (let i = 0; i < buyers.length; i += BATCH_SIZE) {
    chunks.push(buyers.slice(i, i + BATCH_SIZE));
  }

  for (const chunk of chunks) {
    console.log(`🚀 Dispatching batch of ${chunk.length} trades...`);
    
    // Fire all trades in the chunk at once
    const results = await Promise.allSettled(
      chunk.map(user => executeBuy(bot, user, token, true)) // true = silent/background
    );

    results.forEach((res, i) => {
      if (res.status === "rejected") {
        console.error(`Trade failed for user ${chunk[i].userId}:`, res.reason);
      }
    });

    // Optional: tiny delay between batches to help domestic RPCs breathe
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 100));
  }
}

async function executeBuy(bot, user, token, silent = false) {
  const { userId, accountName, autoBuyXpr } = user;

  try {
    // Check XPR balance
    const balance = await getXprBalance(accountName);
    if (balance < autoBuyXpr) {
      if (!silent) {
        await bot.api.sendMessage(Number(userId),
          `⚠️ <b>Insufficient balance</b> for auto-buy of <b>${token.symbol}</b>\n\n` +
          `📬 Account: <code>${accountName}</code>\n` +
          `💰 Balance: <code>${balance.toFixed(4)} XPR</code>\n` +
          `📉 Need:    <code>${autoBuyXpr} XPR</code>\n\n` +
          `Fund your wallet to enable auto-trading.`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      }
      return;
    }

    // Execute buy on-chain
    const txResult = await buyTokens({
      userId,
      accountName,
      tokenId:   token.tokenId,
      xprAmount: autoBuyXpr,
    });

    const txId = txResult?.transaction_id?.slice(0, 16) ?? "confirmed";

    // Record position immediately. We set tokenAmount to 0 for now to avoid blocking.
    // The position monitor or a manual position refresh will fetch the real amount later.
    await openPosition({
      userId,
      accountName,
      symbol:      token.symbol,
      tokenId:     token.tokenId,
      tokenName:   token.name,
      xprSpent:    autoBuyXpr,
      tokenAmount: 0, 
      entryMcap:   token.mcap ?? 0,
      autoSellX:   user.autoSellX,
      autoSellSL:  user.autoSellSL || 0.2,
    });

    // Queue status message (spaced out to avoid Telegram 429)
    setTimeout(async () => {
      await bot.api.sendMessage(Number(userId),
        `✅ <b>Auto-bought ${token.symbol}!</b>\n\n` +
        `💰 Spent:    <code>${autoBuyXpr} XPR</code>\n` +
        `📊 MCap:     <code>$${fmtNum(token.mcap)}</code>\n` +
        `🎯 Target:   <code>${user.autoSellX}x</code>\n` +
        `🔗 TX:       <code>${txId}…</code>\n\n` +
        `Use /positions to track your trades.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }, Math.random() * 5000); // Random delay 0-5s to smooth out bot traffic

  } catch (e) {
    if (!silent) {
      console.error(`Auto-buy failed for user ${user.userId}:`, e.message);
      await bot.api.sendMessage(Number(user.userId),
        `⚠️ Auto-buy failed for <b>${token.symbol}</b>: ${e.message}`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
    throw e;
  }
}

// ─── Monitor positions and auto-sell at target or stop-loss ──────────────────

let isMonitoring = false;

export async function startPositionMonitor(bot) {
  console.log("📊 Position monitor started.");
  
  const tick = async () => {
    if (isMonitoring) return;
    isMonitoring = true;
    
    try {
      await monitorPositions(bot);
    } catch (e) {
      console.error("Monitor loop error:", e.message);
    } finally {
      isMonitoring = false;
      setTimeout(tick, MONITOR_INTERVAL); // Schedule next run ONLY after current one finishes
    }
  };

  tick();
}

async function monitorPositions(bot) {
  let positions;
  try {
    positions = await getAllOpenPositions();
  } catch (e) {
    console.warn("Position monitor — DB unavailable:", e.message);
    return;
  }
  if (!positions.length) return;

  for (const pos of positions) {
    try {
      const token = await getToken(pos.symbol);
      if (!token) continue;

      const currentMcap = token.mcap ?? 0;
      
      // FIX (Bug #2): If entry was 0, it was a brand new launch. 
      // Update entryMcap to the first valid non-zero price we see, then skip this tick.
      if (pos.entryMcap <= 0 && currentMcap > 0) {
        console.log(`📝 Recording first valid mcap for ${pos.symbol}: $${fmtNum(currentMcap)}`);
        // We'll update the position in background
        const col = await getMongoCollection("positions");
        await col.updateOne({ _id: pos._id }, { $set: { entryMcap: currentMcap } });
        continue;
      }

      // Safe calculation: if entry still 0, we can't calculate P/L yet
      const xMultiple = (pos.entryMcap > 0 && currentMcap > 0) ? currentMcap / pos.entryMcap : 0;

      // Target hit
      if (pos.autoSellEnabled !== false && xMultiple >= pos.autoSellX) {
        console.log(`📈 Auto-sell target hit: ${pos.symbol} at ${xMultiple.toFixed(2)}x`);
        await executeSell(bot, pos, token, currentMcap, xMultiple, false);
        continue;
      }

      // Stop-loss: based on per-position setting (default 0.2 i.e. 80% drop)
      const slThreshold = pos.autoSellSL || 0.2;
      if (xMultiple > 0 && xMultiple <= slThreshold) {
        console.log(`🛑 Stop-loss triggered: ${pos.symbol} at ${xMultiple.toFixed(2)}x (limit: ${slThreshold}x)`);
        await executeSell(bot, pos, token, currentMcap, xMultiple, true);
        continue;
      }

    } catch (e) {
      console.error(`Monitor error for ${pos.symbol}:`, e.message);
    }

    await new Promise(r => setTimeout(r, 200));
  }
}

async function executeSell(bot, pos, token, currentMcap, xMultiple, isStopLoss = false) {
  const wallet = await getWallet(pos.userId);
  if (!wallet) return;

  try {
    // Get real on-chain balance from holdings table before selling
    const liveBalance = await getBondingBalance(pos.accountName, pos.tokenId);

    if (!liveBalance || liveBalance <= 0) {
      console.log(`executeSell: no holdings for ${pos.symbol} tokenId=${pos.tokenId} — closing position`);
      // Position may already be sold manually — just close it in DB
      await closePosition({ userId: pos.userId, symbol: pos.symbol, xprReceived: 0 });
      return;
    }

    console.log(`executeSell: selling ${liveBalance} ${pos.symbol} (tokenId=${pos.tokenId})`);

    const txResult = await sellTokens({
      userId:      pos.userId,
      accountName: pos.accountName,
      tokenId:     pos.tokenId,
      tokenAmount: liveBalance,
      symbol:      pos.symbol,
      precision:   4,
    });

    // Estimate XPR received based on mcap multiple
    const xprReceived = pos.xprSpent > 0 ? pos.xprSpent * xMultiple : 0;
    const txId        = txResult?.transaction_id?.slice(0, 16) ?? "confirmed";

    const closed   = await closePosition({ userId: pos.userId, symbol: pos.symbol, xprReceived });
    const isProfit = xprReceived >= pos.xprSpent;
    const emoji    = isStopLoss ? "🛑" : isProfit ? "✅" : "📉";
    const label    = isStopLoss ? "Stop-Loss Triggered" : isProfit ? "Auto-Sold — Profit!" : "Auto-Sold";

    await bot.api.sendMessage(Number(pos.userId),
      `${emoji} <b>${label}</b>\n\n` +
      `🪙 Token:     <code>${pos.tokenName} (${pos.symbol})</code>\n` +
      `🪙 Amount:    <code>${fmtNum(liveBalance)} ${pos.symbol}</code>\n` +
      `📈 Multiple:  <code>${xMultiple.toFixed(2)}x</code>\n` +
      `💰 Spent:     <code>${pos.xprSpent.toFixed(4)} XPR</code>\n` +
      `💵 Received:  <code>~${xprReceived.toFixed(4)} XPR</code>\n` +
      `📊 PNL:       <code>${closed.pnlXpr >= 0 ? "+" : ""}${closed.pnlXpr.toFixed(4)} XPR</code>\n` +
      `🔗 TX:        <code>${txId}…</code>`,
      { parse_mode: "HTML" }
    ).catch(() => {});

  } catch (e) {
    console.error(`Auto-sell failed for ${pos.symbol}:`, e.message);
    await bot.api.sendMessage(Number(pos.userId),
      `⚠️ Auto-sell failed for <b>${pos.symbol}</b>: ${e.message}\n\nUse /sell ${pos.symbol} to sell manually.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  }
}