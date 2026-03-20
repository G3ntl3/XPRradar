import fetch from "node-fetch";

const INDEXER  = "https://indexer.protonnz.com/api";
const HYPERION = "https://api.protonnz.com";
const NODE     = "https://api.protonnz.com";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function apiGet(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.ok) return await res.json();
  } catch (e) {
    console.warn(`Fetch failed: ${url} — ${e.message}`);
  }
  return null;
}

async function nodePost(path, body) {
  try {
    const res = await fetch(`${NODE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return await res.json();
  } catch (e) {
    console.warn(`Node POST failed: ${e.message}`);
  }
  return null;
}

// ─── Get token info from indexer ─────────────────────────────────────────────

async function getTokenInfo(symbol) {
  const data = await apiGet(`${INDEXER}/tokens?symbol=${symbol.toUpperCase()}`);
  return data?.tokens?.[0] ?? null;
}

// ─── Get current token balance of a wallet ───────────────────────────────────

async function getWalletBalance(account, symbol, contract = null) {
  // Try common token contracts
  const contracts = contract
    ? [contract]
    : ["eosio.token", "xtokens", symbol.toLowerCase(), symbol.toLowerCase() + ".token"];

  for (const c of contracts) {
    try {
      const res = await nodePost("/v1/chain/get_table_rows", {
        code: c,
        scope: account,
        table: "accounts",
        limit: 50,
        json: true,
      });
      for (const row of res?.rows ?? []) {
        const parts = String(row.balance ?? "").split(" ");
        if (parts[1]?.toUpperCase() === symbol.toUpperCase()) {
          return { balance: parseFloat(parts[0]) || 0, contract: c };
        }
      }
    } catch {}
  }
  return { balance: 0, contract: null };
}

// ─── Get all token transfers FROM a wallet ────────────────────────────────────

async function getOutgoingTransfers(account, symbol, limit = 100) {
  const data = await apiGet(
    `${HYPERION}/v2/history/get_actions?account=${account}&filter=*:transfer&limit=${limit}&sort=desc`
  );

  const transfers = [];
  for (const action of data?.actions ?? []) {
    const d = action?.act?.data ?? {};
    const from = d.from ?? d.sender ?? "";
    const to   = d.to   ?? d.recipient ?? "";
    const qty  = String(d.quantity ?? d.amount ?? "");
    const sym  = qty.split(" ")[1]?.toUpperCase() ?? "";

    if (from.toLowerCase() === account.toLowerCase() && sym === symbol.toUpperCase()) {
      transfers.push({
        to,
        amount:    parseFloat(qty.split(" ")[0]) || 0,
        timestamp: action.timestamp ?? "",
        tx:        (action.trx_id ?? "").slice(0, 16) + "…",
        memo:      d.memo ?? "",
      });
    }
  }
  return transfers;
}

// ─── Get sell activity from indexer trades ────────────────────────────────────

async function getDevTrades(account, symbol, limit = 100) {
  const data = await apiGet(
    `${INDEXER}/trades?symbol=${symbol.toUpperCase()}&limit=${limit}`
  );

  const trades = Array.isArray(data) ? data : (data?.trades ?? []);
  return trades.filter(t =>
    (t.account ?? t.trader ?? "").toLowerCase() === account.toLowerCase()
  );
}

// ─── Check if a wallet is "fresh" (no prior history) ─────────────────────────

async function isFreshWallet(account) {
  const data = await apiGet(
    `${HYPERION}/v2/history/get_actions?account=${account}&limit=5&sort=asc`
  );
  const actions = data?.actions ?? [];
  if (!actions.length) return true;

  // If oldest action is less than 30 days old = fresh
  const oldest = actions[0]?.timestamp;
  if (!oldest) return false;
  const ageMs = Date.now() - new Date(oldest).getTime();
  return ageMs < 30 * 24 * 60 * 60 * 1000;
}

// ─── Main devcheck function ───────────────────────────────────────────────────

export async function runDevCheck(symbol) {
  symbol = symbol.toUpperCase();

  // 1. Get token info
  const token = await getTokenInfo(symbol);
  if (!token) return { error: `Token ${symbol} not found on SimpleDEX.` };

  const creator    = token.creator;
  const totalSupply = token.supply ?? token.maxSupply ?? 0;
  const price       = token.price ?? 0;

  if (!creator) return { error: `No creator info found for ${symbol}.` };

  // 2. Get current balance
  const { balance: currentBalance } = await getWalletBalance(creator, symbol);

  // 3. Get dev's trades (buys/sells via SimpleDEX)
  const devTrades = await getDevTrades(creator, symbol);
  const devSells  = devTrades.filter(t => t.type === "sell");
  const devBuys   = devTrades.filter(t => t.type === "buy");

  const totalSold   = devSells.reduce((s, t) => s + (t.amount ?? t.quantity ?? 0), 0);
  const totalBought = devBuys.reduce((s,  t) => s + (t.amount ?? t.quantity ?? 0), 0);

  const lastSell = devSells.length
    ? devSells.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0]
    : null;

  // 4. Get outgoing token transfers (to other wallets)
  const outTransfers = await getOutgoingTransfers(creator, symbol);

  // Filter out transfers to known DEX contracts
  const dexContracts = ["protonswap", "alcordexmain", "sdex", "simpledex1", "swap"];
  const suspiciousTransfers = outTransfers.filter(t =>
    !dexContracts.includes(t.to.toLowerCase()) &&
    t.to.toLowerCase() !== creator.toLowerCase()
  );

  // 5. Check if wallets that received tokens are fresh
  const walletChecks = await Promise.all(
    suspiciousTransfers.slice(0, 5).map(async (t) => ({
      ...t,
      isFresh: await isFreshWallet(t.to),
    }))
  );

  const freshWallets    = walletChecks.filter(w => w.isFresh);
  const nonFreshWallets = walletChecks.filter(w => !w.isFresh);

  // 6. Holding % calculation
  const holdingPct = totalSupply > 0 ? (currentBalance / totalSupply) * 100 : 0;
  const valueUsd   = currentBalance * price;

  // ─── Risk Scoring ─────────────────────────────────────────────────────────
  // Each flag adds points. Max score = 10 (highest risk)

  let riskScore  = 0;
  const flags    = [];
  const positive = [];

  // Dev sold checks
  if (totalSold > 0) {
    const soldPct = totalSupply > 0 ? (totalSold / totalSupply) * 100 : 0;
    if (soldPct >= 50) {
      riskScore += 4;
      flags.push(`🔴 Dev sold ${soldPct.toFixed(1)}% of supply`);
    } else if (soldPct >= 20) {
      riskScore += 2;
      flags.push(`🟡 Dev sold ${soldPct.toFixed(1)}% of supply`);
    } else {
      riskScore += 1;
      flags.push(`🟡 Dev sold small amount (${soldPct.toFixed(1)}%)`);
    }
  } else {
    positive.push(`🟢 Dev has not sold any tokens`);
  }

  // Current holding checks
  if (currentBalance === 0) {
    riskScore += 3;
    flags.push(`🔴 Dev holds 0 tokens — fully exited`);
  } else if (holdingPct > 30) {
    riskScore += 2;
    flags.push(`🟡 Dev holds ${holdingPct.toFixed(1)}% — large concentration`);
  } else if (holdingPct > 5) {
    positive.push(`🟢 Dev holds ${holdingPct.toFixed(1)}% of supply`);
  } else {
    positive.push(`🟢 Dev holds small safe amount (${holdingPct.toFixed(1)}%)`);
  }

  // Suspicious wallet transfers
  if (freshWallets.length >= 3) {
    riskScore += 3;
    flags.push(`🔴 Sent tokens to ${freshWallets.length} fresh/new wallets`);
  } else if (freshWallets.length >= 1) {
    riskScore += 2;
    flags.push(`🟡 Sent tokens to ${freshWallets.length} fresh wallet(s)`);
  }

  if (nonFreshWallets.length >= 3) {
    riskScore += 1;
    flags.push(`🟡 Sent tokens to ${nonFreshWallets.length} other wallets`);
  }

  if (suspiciousTransfers.length === 0) {
    positive.push(`🟢 No suspicious wallet transfers detected`);
  }

  // Graduated check
  if (token.graduated) {
    positive.push(`🟢 Token has graduated (bonding curve complete)`);
  } else {
    flags.push(`🟡 Token still on bonding curve`);
    riskScore += 1;
  }

  // Cap score at 10
  riskScore = Math.min(riskScore, 10);

  // Risk label
  let riskLabel, riskEmoji;
  if (riskScore <= 2)      { riskLabel = "Low Risk";      riskEmoji = "🟢"; }
  else if (riskScore <= 4) { riskLabel = "Moderate";      riskEmoji = "🟡"; }
  else if (riskScore <= 6) { riskLabel = "High Risk";     riskEmoji = "🟠"; }
  else                     { riskLabel = "Very High Risk"; riskEmoji = "🔴"; }

  return {
    symbol,
    tokenName:   token.name,
    creator,
    price,
    totalSupply,

    // Holdings
    currentBalance,
    holdingPct,
    valueUsd,

    // Sell activity
    totalSold,
    totalBought,
    sellCount:  devSells.length,
    buyCount:   devBuys.length,
    lastSell,

    // Wallet transfers
    suspiciousTransfers: walletChecks,
    freshWallets,

    // Risk
    riskScore,
    riskLabel,
    riskEmoji,
    flags,
    positive,
  };
}
