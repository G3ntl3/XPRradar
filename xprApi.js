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

// ─── All tokens — fetches ALL pages ──────────────────────────────────────────

export async function getAllTokens() {
  let all = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const data = await get(`/tokens?limit=${limit}&offset=${offset}`);
    const batch = data?.tokens ?? [];
    all = all.concat(batch);

    // Stop if we got fewer than limit (last page) or nothing
    if (batch.length < limit) break;
    offset += limit;

    // Safety cap at 500 tokens
    if (all.length >= 500) break;
  }

  return { tokens: all, count: all.length };
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

// ─── Get a single holder's balance from the holders list ─────────────────────

export async function getHolderBalance(symbol, account) {
  const holders = await getHolders(symbol, 50);
  const match = holders.find(h =>
    (h.account ?? "").toLowerCase() === account.toLowerCase()
  );
  return match ?? null;
}
