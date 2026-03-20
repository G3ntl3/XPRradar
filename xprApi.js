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
