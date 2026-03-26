/**
 * Snapshots — in-memory with async persistence
 *
 * KEY CHANGES FROM ORIGINAL:
 * 1. All reads are instant (Map lookup) — original read entire file every call
 * 2. Writes are async — original used sync writeFileSync on every save
 * 3. File is written max once per 5s (debounced) — not on every saveSnapshot()
 * 4. getUserSnapshots() uses a prefix scan on the Map — no file I/O
 */

import fs   from "fs";
import path from "path";

const SNAP_FILE = "./snapshots.json";

// ─── In-memory store ─────────────────────────────────────────────────────────

const _cache = new Map(); // "userId:SYMBOL" -> { price, timestamp }
let   _dirty = false;

// Load once at startup
try {
  if (fs.existsSync(SNAP_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SNAP_FILE, "utf8"));
    for (const [k, v] of Object.entries(raw)) _cache.set(k, v);
    console.log(`📸 Snapshots loaded: ${_cache.size} entries`);
  }
} catch (e) {
  console.warn("Snapshots load error:", e.message);
}

// Flush to disk every 5s if dirty — fully async, never blocks
setInterval(() => {
  if (!_dirty) return;
  _dirty = false;
  const obj = Object.fromEntries(_cache);
  fs.promises.mkdir(path.dirname(SNAP_FILE), { recursive: true })
    .then(() => fs.promises.writeFile(SNAP_FILE, JSON.stringify(obj)))
    .catch(e => console.warn("Snapshots flush error:", e.message));
}, 5_000);

// ─── Public API ───────────────────────────────────────────────────────────────

export function saveSnapshot(userId, symbol, price) {
  _cache.set(`${userId}:${symbol.toUpperCase()}`, {
    price,
    timestamp: Math.floor(Date.now() / 1000),
  });
  _dirty = true; // will flush within 5s
}

export function getSnapshot(userId, symbol) {
  return _cache.get(`${userId}:${symbol.toUpperCase()}`) ?? null;
}

export function getUserSnapshots(userId) {
  const prefix = `${userId}:`;
  const result = {};
  for (const [k, v] of _cache.entries()) {
    if (k.startsWith(prefix)) result[k.slice(prefix.length)] = v;
  }
  return result;
}