/**
 * Auto Trader
 * - Hooks into launch notifier to auto-buy new tokens
 * - Monitors open positions every 30s and auto-sells at target
 */

import { getAllActiveAutobuyers, getWallet } from "./wallet.js";
import { buyTokens, sellTokens, getXprBalance } from "./trader.js";
import { openPosition, closePosition, getAllOpenPositions } from "./positions.js";
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

  console.log(`🤖 Auto-buying ${token.symbol} for ${buyers.length} users`);

  for (const user of buyers) {
    try {
      await executeBuy(bot, user, token);
      // Small delay between users to avoid nonce issues
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`Auto-buy failed for user ${user.userId}:`, e.message);
      await bot.api.sendMessage(Number(user.userId),
        `⚠️ Auto-buy failed for <b>${token.symbol}</b>: ${e.message}`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
  }
}

async function executeBuy(bot, user, token) {
  const { userId, accountName, autoBuyXpr } = user;

  // Check balance
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

  // Execute buy
  const txResult = await buyTokens({
    userId,
    accountName,
    tokenId:   token.tokenId,
    xprAmount: autoBuyXpr,
  });

  // Estimate tokens received from bonding curve
  // realXpr increases by xprAmount, tokens received = virtualTokens * xprAmount / (virtualXpr + xprAmount)
  const tokensReceived = token.virtualTokens
    ? (parseFloat(token.virtualTokens) * autoBuyXpr) / (parseFloat(token.virtualXpr ?? 0) + autoBuyXpr)
    : 0;

  // Record position
  await openPosition({
    userId,
    accountName,
    symbol:      token.symbol,
    tokenId:     token.tokenId,
    tokenName:   token.name,
    xprSpent:    autoBuyXpr,
    tokenAmount: tokensReceived,
    entryMcap:   token.mcap ?? 0,
    autoSellX:   user.autoSellX,
  });

  const txId = txResult?.transaction_id?.slice(0, 16) ?? "confirmed";

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
}

// ─── Monitor positions and auto-sell at target ────────────────────────────────

export async function startPositionMonitor(bot) {
  console.log("📊 Position monitor started.");
  setInterval(() => monitorPositions(bot).catch(console.error), MONITOR_INTERVAL);
}

async function monitorPositions(bot) {
  let positions;
  try {
    positions = await getAllOpenPositions();
  } catch (e) {
    console.warn("Position monitor — DB unavailable:", e.message);
    return; // Skip this cycle, try again next interval
  }
  if (!positions.length) return;

  for (const pos of positions) {
    try {
      const token = await getToken(pos.symbol);
      if (!token) continue;

      const currentMcap = token.mcap ?? 0;
      const xMultiple   = pos.entryMcap > 0 ? currentMcap / pos.entryMcap : 0;

      // Check if target hit
      if (xMultiple >= pos.autoSellX) {
        await executeSell(bot, pos, token, currentMcap, xMultiple);
      }

      // Stop-loss: auto-sell if down 60% from entry
      if (xMultiple > 0 && xMultiple <= 0.4) {
        await executeSell(bot, pos, token, currentMcap, xMultiple, true);
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
    const txResult = await sellTokens({
      userId:      pos.userId,
      accountName: pos.accountName,
      tokenId:     pos.tokenId,
      tokenAmount: pos.tokenAmount,
      precision:   4,
    });

    // Estimate XPR received
    const xprReceived = pos.xprSpent * xMultiple;

    const closed = await closePosition({
      userId:      pos.userId,
      symbol:      pos.symbol,
      xprReceived,
    });

    const isProfit = xprReceived >= pos.xprSpent;
    const emoji    = isStopLoss ? "🛑" : isProfit ? "✅" : "📉";
    const label    = isStopLoss ? "Stop-Loss Triggered" : isProfit ? "Auto-Sold — Profit!" : "Auto-Sold";
    const txId     = txResult?.transaction_id?.slice(0, 16) ?? "confirmed";

    await bot.api.sendMessage(Number(pos.userId),
      `${emoji} <b>${label}</b>\n\n` +
      `🪙 Token:     <code>${pos.tokenName} (${pos.symbol})</code>\n` +
      `📈 Multiple:  <code>${xMultiple.toFixed(2)}x</code>\n` +
      `💰 Spent:     <code>${pos.xprSpent.toFixed(4)} XPR</code>\n` +
      `💵 Received:  <code>${xprReceived.toFixed(4)} XPR</code>\n` +
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
