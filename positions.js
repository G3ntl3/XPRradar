/**
 * Positions Tracker
 * Tracks each user's open trades — entry mcap, token amount, target
 */

import { getMongoCollection } from "./db.js";

// ─── Open a position after a buy ──────────────────────────────────────────────
export async function openPosition({
  userId, accountName, symbol, tokenId,
  tokenName, xprSpent, tokenAmount, entryMcap, autoSellX, autoSellSL, precision = 4
}) {
  const col = await getMongoCollection("positions");
  await col.insertOne({
    userId:      String(userId),
    accountName,
    symbol,
    tokenId,
    tokenName,
    xprSpent,
    tokenAmount,
    entryMcap,
    targetMcap:  entryMcap * autoSellX,
    stopMcap:    entryMcap * (autoSellSL || 0.6), // Default to -40% if not set
    autoSellX,
    autoSellSL:  autoSellSL || 0.6,
    precision,
    openedAt:    new Date(),
    status:      "open",
  });
}

// ─── Update position settings ────────────────────────────────────────────────
export async function updatePositionSL(userId, symbol, autoSellSL) {
  const col = await getMongoCollection("positions");
  const pos = await col.findOne({ userId: String(userId), symbol, status: "open" });
  if (!pos) return false;

  await col.updateOne(
    { _id: pos._id },
    { $set: { 
      autoSellSL,
      stopMcap: pos.entryMcap * autoSellSL 
    }}
  );
  return true;
}

// ─── Close a position after a sell ───────────────────────────────────────────

export async function closePosition({ userId, symbol, xprReceived }) {
  const col = await getMongoCollection("positions");
  const pos = await col.findOne({ userId: String(userId), symbol, status: "open" });
  if (!pos) return null;

  const pnlXpr  = xprReceived - pos.xprSpent;
  const pnlPct  = ((xprReceived - pos.xprSpent) / pos.xprSpent) * 100;
  const xMulti  = xprReceived / pos.xprSpent;

  await col.updateOne(
    { _id: pos._id },
    { $set: {
      status:      "closed",
      xprReceived,
      pnlXpr,
      pnlPct,
      xMulti,
      closedAt:    new Date(),
    }}
  );

  return { ...pos, xprReceived, pnlXpr, pnlPct, xMulti };
}

// ─── Get all open positions ───────────────────────────────────────────────────

export async function getOpenPositions(userId) {
  const col = await getMongoCollection("positions");
  return col.find({ userId: String(userId), status: "open" }).toArray();
}

export async function getAllOpenPositions() {
  const col = await getMongoCollection("positions");
  return col.find({ status: "open" }).toArray();
}

// ─── Get trade history ────────────────────────────────────────────────────────

export async function getTradeHistory(userId, limit = 10) {
  const col = await getMongoCollection("positions");
  return col.find({ userId: String(userId), status: "closed" })
    .sort({ closedAt: -1 })
    .limit(limit)
    .toArray();
}

// ─── Get position by symbol ───────────────────────────────────────────────────

export async function getPosition(userId, symbol) {
  const col = await getMongoCollection("positions");
  return col.findOne({ userId: String(userId), symbol, status: "open" });
}
