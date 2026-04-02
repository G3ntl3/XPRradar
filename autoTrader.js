/**
 * Auto Trader
 * - Auto-buys new tokens for subscribed users on launch
 * - Monitors open positions every 30s, auto-sells at target or stop-loss
 * - Auto-saves PNL snapshot when token is bought (for /pnl tracking)
 */

import { getAllActiveAutobuyers, getWallet } from "./wallet.js";
import { buyTokens, sellTokens, getXprBalance, getBondingBalance, getTokenPrecision } from "./trader.js";
import { openPosition, closePosition, getAllOpenPositions } from "./positions.js";
import { saveSnapshot } from "./snapshots.js";
import { getToken } from "./xprApi.js";

const MONITOR_INTERVAL = 30_000;

function fmtNum(n) {
  if (!n && n !== 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(2);
}

// ─── Auto-buy a new token for all subscribed users ────────────────────────────

export async function autoBuyNewToken(bot, token) {
  if (token.graduated) return;

  const buyers = await getAllActiveAutobuyers();
  if (!buyers.length) return;

  console.log(`🤖 Auto-buying ${token.symbol} (tokenId=${token.tokenId}) for ${buyers.length} users`);

  const BATCH_SIZE = 50;
  for (let i = 0; i < buyers.length; i += BATCH_SIZE) {
    const chunk = buyers.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      chunk.map(user => executeBuy(bot, user, token))
    );

    results.forEach((res, idx) => {
      if (res.status === "rejected") {
        console.error(`Auto-buy failed for user ${chunk[idx].userId}:`, res.reason?.message ?? res.reason);
      }
    });

    if (i + BATCH_SIZE < buyers.length) await new Promise(r => setTimeout(r, 100));
  }
}

async function executeBuy(bot, user, token) {
  const { userId, accountName, autoBuyXpr } = user;

  // Check XPR balance
  const balance = await getXprBalance(accountName);
  if (balance < autoBuyXpr) {
    await bot.api.sendMessage(Number(userId),
      `⚠️ Insufficient balance for auto-buy of <b>${token.symbol}</b>\n` +
      `Need: <code>${autoBuyXpr} XPR</code> | Have: <code>${balance.toFixed(4)} XPR</code>\n\n` +
      `Fund your wallet to enable auto-trading.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

  // Execute buy on-chain
  const txResult = await buyTokens({
    userId,
    accountName,
    tokenId:   token.tokenId,
    xprAmount: autoBuyXpr,
  });

  const txId      = txResult?.transaction_id?.slice(0, 16) ?? "confirmed";
  const precision = await getTokenPrecision(token.symbol).catch(() => 4);
  const boughtAt  = Math.floor(Date.now() / 1000);

  // Save PNL snapshot at buy time so /pnl tracking works automatically
  saveSnapshot(userId, token.symbol, token.mcap ?? 0);

  // Record position with openedAt timestamp
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
    autoSellSL:  user.autoSellSL || 0.6,
    precision,
    openedAt:    boughtAt,
  });

  // Notify user (delayed slightly to spread Telegram load)
  setTimeout(async () => {
    await bot.api.sendMessage(Number(userId),
      `✅ <b>Auto-bought ${token.symbol}!</b>\n\n` +
      `💰 Spent:    <code>${autoBuyXpr} XPR</code>\n` +
      `🪙 Token:    <code>${token.name}</code>\n` +
      `📊 MCap:     <code>$${fmtNum(token.mcap)}</code>\n` +
      `🎯 Sell at:  <code>${user.autoSellX}x</code> mcap\n` +
      `🔗 TX:       <code>${txId}…</code>\n\n` +
      `Use /positions to track your trades.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  }, Math.random() * 3000);
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
      setTimeout(tick, MONITOR_INTERVAL);
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
      const xMultiple   = pos.entryMcap > 0 && currentMcap > 0
        ? currentMcap / pos.entryMcap
        : 0;

      // Target hit
      if (xMultiple >= pos.autoSellX) {
        console.log(`📈 Auto-sell target: ${pos.symbol} at ${xMultiple.toFixed(2)}x`);
        await executeSell(bot, pos, token, currentMcap, xMultiple, false);
        continue;
      }

      // Stop-loss
      const slThreshold = pos.autoSellSL || 0.6;
      if (xMultiple > 0 && xMultiple <= slThreshold) {
        console.log(`🛑 Stop-loss: ${pos.symbol} at ${xMultiple.toFixed(2)}x (limit ${slThreshold}x)`);
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
    const precision   = pos.precision || 4;
    const liveBalance = await getBondingBalance(pos.accountName, pos.tokenId, precision);

    if (!liveBalance || liveBalance <= 0) {
      console.log(`executeSell: no holdings for ${pos.symbol} — closing position in DB`);
      await closePosition({ userId: pos.userId, symbol: pos.symbol, xprReceived: 0 });
      return;
    }

    const txResult = await sellTokens({
      userId:      pos.userId,
      accountName: pos.accountName,
      tokenId:     pos.tokenId,
      tokenAmount: liveBalance,
      symbol:      pos.symbol,
      precision,
    });

    let xprReceivedFromTx = 0;
    try {
      const traces = txResult?.processed?.action_traces || [];
      for (const trace of traces) {
        for (const inline of (trace.inline_traces || [])) {
          if (inline.act?.account === "eosio.token" && inline.act?.name === "transfer") {
            const data = inline.act.data;
            if (data?.to === pos.accountName && data?.quantity?.includes("XPR")) {
              xprReceivedFromTx += parseFloat(data.quantity.split(" ")[0]);
            }
          }
        }
      }
    } catch (e) {}

    const xprReceived = xprReceivedFromTx > 0 ? xprReceivedFromTx : (pos.xprSpent > 0 ? pos.xprSpent * xMultiple : 0);
    const txId        = txResult?.transaction_id?.slice(0, 16) ?? "confirmed";
    const closed      = await closePosition({ userId: pos.userId, symbol: pos.symbol, xprReceived });

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