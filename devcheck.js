import fetch from "node-fetch";

const INDEXER  = "https://indexer.protonnz.com/api";
const HYPERION = "https://api.protonnz.com";

async function apiGet(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.ok) return await res.json();
  } catch (e) {
    console.warn(`Fetch failed: ${url} — ${e.message}`);
  }
  return null;
}

// ─── Get token info ───────────────────────────────────────────────────────────

async function getTokenInfo(symbol) {
  const data = await apiGet(`${INDEXER}/tokens?symbol=${symbol.toUpperCase()}`);
  return data?.tokens?.[0] ?? null;
}

// ─── Get dev balance from holders list (using tokenId) ───────────────────────

async function getDevBalance(tokenId, account) {
  // Fetch up to 200 holders using correct tokenId-based URL
  const data = await apiGet(`${INDEXER}/tokens/${tokenId}/holders?limit=200`);
  const holders = data?.holders ?? (Array.isArray(data) ? data : []);
  const match = holders.find(h =>
    (h.account ?? "").toLowerCase() === account.toLowerCase()
  );
  if (!match) return 0;
  // walletAmount = in wallet, lpAmount = in liquidity pool — sum both
  return parseFloat(match.walletAmount ?? match.amount ?? 0) +
         parseFloat(match.lpAmount ?? 0);
}

// ─── Get dev trades (using tokenId) ──────────────────────────────────────────

async function getDevTrades(tokenId, account, limit = 100) {
  const data = await apiGet(`${INDEXER}/tokens/${tokenId}/trades?limit=${limit}`);
  const trades = data?.trades ?? (Array.isArray(data) ? data : []);
  return trades.filter(t =>
    (t.account ?? t.trader ?? "").toLowerCase() === account.toLowerCase()
  );
}

// ─── Get outgoing token transfers from Hyperion ───────────────────────────────

async function getOutgoingTransfers(account, symbol, limit = 100) {
  const data = await apiGet(
    `${HYPERION}/v2/history/get_actions?account=${account}&filter=*:transfer&limit=${limit}&sort=desc`
  );
  const transfers = [];
  for (const action of data?.actions ?? []) {
    const d   = action?.act?.data ?? {};
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

// ─── Check if a wallet is fresh (<30 days old) ───────────────────────────────

async function isFreshWallet(account) {
  const data = await apiGet(
    `${HYPERION}/v2/history/get_actions?account=${account}&limit=5&sort=asc`
  );
  const actions = data?.actions ?? [];
  if (!actions.length) return true;
  const oldest = actions[0]?.timestamp;
  if (!oldest) return false;
  return Date.now() - new Date(oldest).getTime() < 30 * 24 * 60 * 60 * 1000;
}

// ─── Main devcheck ────────────────────────────────────────────────────────────

export async function runDevCheck(symbol) {
  symbol = symbol.toUpperCase();

  // 1. Get token
  const token = await getTokenInfo(symbol);
  if (!token)    return { error: `Token ${symbol} not found on SimpleDEX.` };
  if (!token.creator) return { error: `No creator info found for ${symbol}.` };

  const { tokenId, creator, supply, maxSupply, price = 0 } = token;
  const totalSupply = supply ?? maxSupply ?? 0;

  // 2. Run all lookups in parallel for speed
  const [currentBalance, devTrades, outTransfers] = await Promise.all([
    getDevBalance(tokenId, creator),
    getDevTrades(tokenId, creator, 100),
    getOutgoingTransfers(creator, symbol, 100),
  ]);

  // 3. Analyse trades
  const devSells  = devTrades.filter(t => t.type === "sell");
  const devBuys   = devTrades.filter(t => t.type === "buy");
  const totalSold = devSells.reduce((s, t) => s + (t.amount ?? t.quantity ?? 0), 0);
  const lastSell  = devSells.length
    ? devSells.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0]
    : null;

  // 4. Filter suspicious transfers (not to known DEX contracts)
  const dexContracts = ["protonswap", "alcordexmain", "sdex", "simpledex1", "swap"];
  const suspicious = outTransfers.filter(t =>
    !dexContracts.includes(t.to.toLowerCase()) &&
    t.to.toLowerCase() !== creator.toLowerCase()
  );

  // 5. Check freshness of wallets that received tokens
  const walletChecks = await Promise.all(
    suspicious.slice(0, 5).map(async t => ({
      ...t,
      isFresh: await isFreshWallet(t.to),
    }))
  );

  const freshWallets = walletChecks.filter(w => w.isFresh);

  // 6. Holding stats
  const holdingPct = totalSupply > 0 ? (currentBalance / totalSupply) * 100 : 0;
  const valueUsd   = currentBalance * price;

  // ─── Risk scoring ─────────────────────────────────────────────────────────

  let riskScore = 0;
  const flags   = [];
  const positive = [];

  // Sell checks
  if (totalSold > 0) {
    const soldPct = totalSupply > 0 ? (totalSold / totalSupply) * 100 : 0;
    if (soldPct >= 50)      { riskScore += 4; flags.push(`🔴 Dev sold ${soldPct.toFixed(1)}% of supply`); }
    else if (soldPct >= 20) { riskScore += 2; flags.push(`🟡 Dev sold ${soldPct.toFixed(1)}% of supply`); }
    else                    { riskScore += 1; flags.push(`🟡 Dev sold small amount (${soldPct.toFixed(1)}%)`); }
  } else {
    positive.push(`🟢 Dev has not sold any tokens`);
  }

  // Holding checks
  if (currentBalance === 0) {
    riskScore += 3; flags.push(`🔴 Dev holds 0 tokens — fully exited`);
  } else if (holdingPct > 30) {
    riskScore += 2; flags.push(`🟡 Dev holds ${holdingPct.toFixed(1)}% — large concentration`);
  } else if (holdingPct > 5) {
    positive.push(`🟢 Dev holds ${holdingPct.toFixed(1)}% of supply`);
  } else {
    positive.push(`🟢 Dev holds small safe amount (${holdingPct.toFixed(1)}%)`);
  }

  // Wallet clustering
  if (freshWallets.length >= 3)      { riskScore += 3; flags.push(`🔴 Sent tokens to ${freshWallets.length} fresh/new wallets`); }
  else if (freshWallets.length >= 1) { riskScore += 2; flags.push(`🟡 Sent tokens to ${freshWallets.length} fresh wallet(s)`); }

  if (walletChecks.filter(w => !w.isFresh).length >= 3) {
    riskScore += 1; flags.push(`🟡 Sent tokens to ${walletChecks.filter(w => !w.isFresh).length} other wallets`);
  }

  if (suspicious.length === 0) positive.push(`🟢 No suspicious wallet transfers detected`);

  // Graduated
  if (token.graduated) positive.push(`🟢 Token has graduated (bonding curve complete)`);
  else { flags.push(`🟡 Token still on bonding curve`); riskScore += 1; }

  riskScore = Math.min(riskScore, 10);

  let riskLabel, riskEmoji;
  if (riskScore <= 2)      { riskLabel = "Low Risk";       riskEmoji = "🟢"; }
  else if (riskScore <= 4) { riskLabel = "Moderate";       riskEmoji = "🟡"; }
  else if (riskScore <= 6) { riskLabel = "High Risk";      riskEmoji = "🟠"; }
  else                     { riskLabel = "Very High Risk";  riskEmoji = "🔴"; }

  return {
    symbol, tokenName: token.name, creator, price, totalSupply,
    currentBalance, holdingPct, valueUsd,
    totalSold, sellCount: devSells.length, buyCount: devBuys.length, lastSell,
    suspiciousTransfers: walletChecks, freshWallets,
    riskScore, riskLabel, riskEmoji, flags, positive,
  };
}
