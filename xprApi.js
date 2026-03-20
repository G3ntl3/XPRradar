import fetch from "node-fetch";

const NODES = [
  "https://api.protonnz.com",
  "https://proton.eosusa.io",
  "https://main.proton.kiwi",
];

// ─── Core HTTP ────────────────────────────────────────────────────────────────

async function post(path, body) {
  for (const node of NODES) {
    try {
      const res = await fetch(`${node}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.warn(`${node} failed: ${e.message}`);
    }
  }
  return null;
}

async function getHyperion(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await fetch(`${NODES[0]}${path}?${qs}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return await res.json();
  } catch (e) {
    console.warn(`Hyperion error: ${e.message}`);
  }
  return null;
}

async function getTableRows(code, scope, table, limit = 50) {
  const result = await post("/v1/chain/get_table_rows", {
    code, scope, table, limit, json: true,
  });
  return result?.rows ?? [];
}

// ─── Asset parser ─────────────────────────────────────────────────────────────

function parseAsset(str = "") {
  const [amount, symbol] = String(str).trim().split(/\s+/);
  return { amount: parseFloat(amount) || 0, symbol: symbol || "" };
}

// ─── Contract discovery ───────────────────────────────────────────────────────

let _contract = null;

async function getContract() {
  if (_contract) return _contract;
  for (const name of ["sdex", "simpledex1", "protonswap", "swap.proton"]) {
    const rows = await getTableRows(name, name, "pairs", 1);
    if (rows.length) { _contract = name; return name; }
  }
  return "sdex";
}

// ─── Token metadata from XPR token contract ───────────────────────────────────

export async function getTokenMetadata(symbol) {
  symbol = symbol.toUpperCase();

  // Try to find the token's issuer contract via currency stats
  // Common token contracts on XPR Network
  const contracts = [
    "xtokens",       // XPR native wrapped tokens
    "eosio.token",   // system token
    "proton.wrap",
    symbol.toLowerCase() + ".token",
    symbol.toLowerCase(),
  ];

  let stats = null;
  let contractName = null;

  for (const contract of contracts) {
    const rows = await getTableRows(contract, symbol, "stat", 1);
    if (rows.length) {
      stats = rows[0];
      contractName = contract;
      break;
    }
  }

  return { stats, contractName };
}

// ─── Pool data ────────────────────────────────────────────────────────────────

export async function getTokenPool(symbol) {
  symbol = symbol.toUpperCase();
  const contract = await getContract();

  // Try multiple table names
  for (const table of ["pairs", "pools", "lpairs"]) {
    const rows = await getTableRows(contract, contract, table, 200);
    for (const row of rows) {
      const r0 = parseAsset(row.reserve0 ?? row.token0_quantity ?? row.pool1 ?? "");
      const r1 = parseAsset(row.reserve1 ?? row.token1_quantity ?? row.pool2 ?? "");
      if (r0.symbol === symbol || r1.symbol === symbol) {
        const price = r0.amount > 0 ? r1.amount / r0.amount : 0;
        const priceInv = r1.amount > 0 ? r0.amount / r1.amount : 0;
        return {
          id:       row.id ?? row.pair_id ?? `${r0.symbol}-${r1.symbol}`,
          token0:   r0.symbol,
          token1:   r1.symbol,
          reserve0: r0.amount,
          reserve1: r1.amount,
          price:    r0.symbol === symbol ? price : priceInv,     // price of queried token
          quoteToken: r0.symbol === symbol ? r1.symbol : r0.symbol,
          fee:      parseFloat(row.fee ?? 0.002),
          lpSupply: parseFloat(row.supply ?? row.lp_supply ?? 0),
          bonded:   row.bonded ?? row.active ?? null,
          raw:      row,
        };
      }
    }
  }
  return null;
}

// ─── All pools (for /tokens list) ────────────────────────────────────────────

export async function getAllPools() {
  const contract = await getContract();
  for (const table of ["pairs", "pools", "lpairs"]) {
    const rows = await getTableRows(contract, contract, table, 200);
    if (rows.length) {
      return rows.map(row => {
        const r0 = parseAsset(row.reserve0 ?? row.token0_quantity ?? row.pool1 ?? "");
        const r1 = parseAsset(row.reserve1 ?? row.token1_quantity ?? row.pool2 ?? "");
        return { token0: r0.symbol, token1: r1.symbol, reserve0: r0.amount, reserve1: r1.amount };
      }).filter(p => p.token0 && p.token1);
    }
  }
  return [];
}

// ─── Recent trades for a token ────────────────────────────────────────────────

export async function getRecentTrades(symbol, limit = 5) {
  symbol = symbol.toUpperCase();
  const contract = await getContract();
  const data = await getHyperion("/v2/history/get_actions", {
    account: contract,
    filter: `${contract}:swap`,
    limit: 50,
    sort: "desc",
  });

  const trades = [];
  for (const action of data?.actions ?? []) {
    const d = action?.act?.data ?? {};
    const qIn  = parseAsset(d.quantity_in  ?? d.asset_in  ?? "");
    const qOut = parseAsset(d.quantity_out ?? d.asset_out ?? "");
    if (!qIn.symbol || !qOut.symbol) continue;
    if (qIn.symbol !== symbol && qOut.symbol !== symbol) continue;

    trades.push({
      trader:    action?.act?.authorization?.[0]?.actor ?? "unknown",
      tokenIn:   qIn.symbol,
      tokenOut:  qOut.symbol,
      amountIn:  qIn.amount,
      amountOut: qOut.amount,
      timestamp: action.timestamp ?? "",
      tx:        (action.trx_id ?? "").slice(0, 12) + "…",
    });
    if (trades.length >= limit) break;
  }
  return trades;
}
