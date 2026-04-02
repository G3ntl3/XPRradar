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
  const positions = await col.find({ userId: String(userId), symbol, status: "open" }).toArray();
  if (!positions.length) return null;

  const totalSpent = positions.reduce((sum, p) => sum + (p.xprSpent || 0), 0);
  const xMulti = totalSpent > 0 ? xprReceived / totalSpent : 0;

  for (const pos of positions) {
    const allocatedReceived = totalSpent > 0 ? ((pos.xprSpent || 0) / totalSpent) * xprReceived : xprReceived / positions.length;
    const pnlXpr = allocatedReceived - (pos.xprSpent || 0);
    const pnlPct = pos.xprSpent ? (pnlXpr / pos.xprSpent) * 100 : 0;

    await col.updateOne(
      { _id: pos._id },
      { $set: {
        status:      "closed",
        xprReceived: allocatedReceived,
        pnlXpr,
        pnlPct,
        xMulti,
        closedAt:    new Date(),
      }}
    );
  }

  return {
    ...positions[0],
    xprSpent: totalSpent,
    xprReceived,
    pnlXpr: xprReceived - totalSpent,
    xMulti
  };
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

export async function getPositions(userId, symbol) {
  const col = await getMongoCollection("positions");
  return col.find({ userId: String(userId), symbol, status: "open" }).toArray();
}
