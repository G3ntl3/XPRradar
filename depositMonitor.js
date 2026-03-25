/**
 * Deposit Monitor
 * Polls XPR Network for incoming transfers to all registered trading wallets
 * Notifies users when funds arrive
 */

import fetch from "node-fetch";
import { getMongoCollection } from "./db.js";

const XPR_NODE     = "https://api.protonnz.com";
const POLL_MS      = 15_000; // check every 15 seconds
const HISTORY_FILE = "./data/last_deposit_seq.json";

import fs from "fs";

function loadSeqs() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {}
  return {};
}

function saveSeqs(data) {
  if (!fs.existsSync("./data")) fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

function fmtNum(n) {
  if (!n && n !== 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return parseFloat(n).toFixed(4);
}

async function getRecentTransfers(accountName, lastSeq = 0) {
  try {
    const res = await fetch(
      `${XPR_NODE}/v2/history/get_actions?account=${accountName}&filter=eosio.token:transfer&limit=10&sort=desc`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const actions = data?.actions ?? [];

    // Filter: only incoming transfers after lastSeq
    return actions.filter(a => {
      const act = a.act?.data;
      return (
        a.global_sequence > lastSeq &&
        act?.to === accountName &&
        act?.from !== accountName
      );
    });
  } catch (e) {
    console.warn(`Deposit monitor fetch error for ${accountName}:`, e.message);
    return [];
  }
}

async function pollDeposits(bot) {
  let wallets;
  try {
    const col = await getMongoCollection("wallets");
    const result = await col.find({});
    wallets = await result.toArray();
  } catch {
    return; // DB unavailable, skip
  }

  if (!wallets.length) return;

  const seqs = loadSeqs();

  for (const wallet of wallets) {
    const { userId, accountName } = wallet;
    const lastSeq = seqs[accountName] ?? 0;

    const transfers = await getRecentTransfers(accountName, lastSeq);
    if (!transfers.length) continue;

    // Update sequence tracker
    const maxSeq = Math.max(...transfers.map(t => t.global_sequence));
    seqs[accountName] = maxSeq;

    // Notify user for each deposit
    for (const t of transfers) {
      const act      = t.act.data;
      const amount   = act.quantity ?? "? XPR";
      const from     = act.from ?? "unknown";
      const memo     = act.memo ? `\n📝 Memo: <i>${act.memo}</i>` : "";

      await bot.api.sendMessage(Number(userId),
        `💰 <b>Deposit Received!</b>\n\n` +
        `Amount: <code>${amount}</code>\n` +
        `From:   <code>${from}</code>${memo}\n\n` +
        `Your wallet: <code>${accountName}</code>\n` +
        `Use /balance to see your updated balance.`,
        { parse_mode: "HTML" }
      ).catch(e => console.warn(`Deposit notify failed for ${userId}:`, e.message));
    }
  }

  saveSeqs(seqs);
}

export function startDepositMonitor(bot) {
  console.log("💰 Deposit monitor started.");
  // Initial seed — mark current sequence so we don't spam on startup
  setTimeout(async () => {
    try {
      const col = await getMongoCollection("wallets");
      const result = await col.find({});
      const wallets = await result.toArray();
      const seqs = loadSeqs();
      for (const w of wallets) {
        if (!seqs[w.accountName]) {
          const transfers = await getRecentTransfers(w.accountName, 0);
          if (transfers.length) {
            seqs[w.accountName] = Math.max(...transfers.map(t => t.global_sequence));
          }
        }
      }
      saveSeqs(seqs);
      console.log("💰 Deposit monitor seeded.");
    } catch {}
    // Start polling after seed
    setInterval(() => pollDeposits(bot).catch(console.error), POLL_MS);
  }, 5000);
}
