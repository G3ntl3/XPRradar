import fetch from "node-fetch";

const API = "https://indexer.protonnz.com/api";

async function get(path) {
  try {
    const res = await fetch(`${API}${path}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return await res.json();
    console.warn(`API ${path} returned ${res.status}`);
  } catch (e) {
    console.warn(`API error on ${path}: ${e.message}`);
  }
  return null;
}

// ─── Single token info ────────────────────────────────────────────────────────

export async function getToken(symbol) {
  const data = await get(`/tokens?symbol=${symbol.toUpperCase()}`);
  return data?.tokens?.[0] ?? null;
}

// ─── All tokens (paginated) ───────────────────────────────────────────────────

export async function getAllTokens(limit = 50, offset = 0) {
  const data = await get(`/tokens?limit=${limit}&offset=${offset}`);
  return { tokens: data?.tokens ?? [], count: data?.count ?? 0 };
}

// ─── Recent trades for a token ────────────────────────────────────────────────

export async function getTrades(symbol, limit = 5) {
  const data = await get(`/trades?symbol=${symbol.toUpperCase()}&limit=${limit}`);
  return data?.trades ?? data ?? [];
}

// ─── Top holders for a token ──────────────────────────────────────────────────

export async function getHolders(symbol, limit = 5) {
  const data = await get(`/holders?symbol=${symbol.toUpperCase()}&limit=${limit}`);
  return data?.holders ?? data ?? [];
}

// ─── Price history ────────────────────────────────────────────────────────────

export async function getHistory(symbol, since = null) {
  const ts = since ?? Math.floor(Date.now() / 1000) - 86400; // default: last 24h
  const data = await get(`/history?symbol=${symbol.toUpperCase()}&since=${ts}`);
  return data ?? [];
}
