import fetch from "node-fetch";

const API = "https://indexer.protonnz.com/api";

async function get(path) {
  try {
    const res = await fetch(`${API}${path}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return await res.json();
    console.warn(`API ${path} returned ${res.status}`);
  } catch (e) {
    console.warn(`API error on ${path}: ${e.message}`);
  }
  return null;
}

// ─── Single token ─────────────────────────────────────────────────────────────

export async function getToken(symbol) {
  const data = await get(`/tokens?symbol=${symbol.toUpperCase()}`);
  return data?.tokens?.[0] ?? null;
}

// ─── All tokens — single request, no pagination needed ───────────────────────

export async function getAllTokens() {
  // API returns all tokens in one shot (confirmed 268 tokens, no pagination)
  const data = await get(`/tokens?limit=500`);
  const tokens = data?.tokens ?? [];
  return { tokens, count: tokens.length };
}

// ─── Trades — uses tokenId ────────────────────────────────────────────────────

export async function getTrades(symbol, limit = 5) {
  const token = await getToken(symbol);
  if (!token?.tokenId) return [];
  const data = await get(`/tokens/${token.tokenId}/trades?limit=${limit}`);
  return data?.trades ?? (Array.isArray(data) ? data : []);
}

// ─── Holders — uses tokenId ───────────────────────────────────────────────────

export async function getHolders(symbol, limit = 10) {
  const token = await getToken(symbol);
  if (!token?.tokenId) return [];
  const data = await get(`/tokens/${token.tokenId}/holders?limit=${limit}`);
  return data?.holders ?? (Array.isArray(data) ? data : []);
}

// ─── Bonding curve data for a specific token ──────────────────────────────────
// Fetches realXpr from on-chain contract table, threshold from config table

const XPR_NODE = "https://api.protonnz.com";

async function nodePost(body) {
  try {
    const res = await fetch(`${XPR_NODE}/v1/chain/get_table_rows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, json: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return await res.json();
  } catch (e) {
    console.warn(`Node POST error: ${e.message}`);
  }
  return null;
}

// Cached threshold — only fetches once
let _threshold = null;

async function getBondingThreshold() {
  if (_threshold !== null) return _threshold;
  const data = await nodePost({
    code: "simplelaunch",
    scope: "simplelaunch",
    table: "config",
    limit: 1,
  });
  // threshold is stored as integer with 4 decimal places (e.g. 500000000 = 50000.0000 XPR)
  const raw = data?.rows?.[0]?.threshold ?? 500_000_000;
  _threshold = raw / 10000;  // → 50000.0000 XPR
  return _threshold;
}

export async function getBondingProgress(tokenId) {
  const [tokenData, threshold] = await Promise.all([
    nodePost({
      code: "simplelaunch",
      scope: "simplelaunch",
      table: "tokens",
      lower_bound: tokenId,
      upper_bound: tokenId,
      limit: 1,
    }),
    getBondingThreshold(),
  ]);

  const row = tokenData?.rows?.[0];
  if (!row) return null;

  // realXpr is also stored as integer with 4 decimal places
  const realXpr   = parseFloat(row.realXpr ?? 0) / 10000;
  const graduated = row.graduated === 1 || row.graduated === true;
  const pct       = Math.min((realXpr / threshold) * 100, 100);

  return { realXpr, threshold, pct, graduated };
}
