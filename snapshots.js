import fs from "fs";

const SNAPSHOT_FILE = "./snapshots.json";

function load() {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch {}
  return {};
}

function save(data) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2));
}

// Save price snapshot when user checks a token
// Key: userId:SYMBOL
export function saveSnapshot(userId, symbol, price) {
  const data = load();
  const key = `${userId}:${symbol.toUpperCase()}`;
  data[key] = {
    price,
    timestamp: Math.floor(Date.now() / 1000),
  };
  save(data);
}

// Get last snapshot for a user + token
export function getSnapshot(userId, symbol) {
  const data = load();
  return data[`${userId}:${symbol.toUpperCase()}`] ?? null;
}

// Get all snapshots for a user
export function getUserSnapshots(userId) {
  const data = load();
  const result = {};
  for (const [key, val] of Object.entries(data)) {
    const [uid, symbol] = key.split(":");
    if (uid === String(userId)) result[symbol] = val;
  }
  return result;
}
