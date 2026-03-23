/**
 * MongoDB connection manager
 * Reuses a single connection across all modules
 *
 * Required env var:
 *   MONGODB_URI — e.g. mongodb+srv://user:pass@cluster.mongodb.net/xprradar
 */

import { MongoClient } from "mongodb";

const URI = process.env.MONGODB_URI;
const DB  = "xprradar";

let _client = null;
let _db     = null;
let _connecting = false;

export async function getDb() {
  // Return existing connection if healthy
  if (_db && _client) {
    try {
      await _client.db("admin").command({ ping: 1 });
      return _db;
    } catch {
      // Connection dropped — reset and reconnect
      _db = null;
      _client = null;
    }
  }

  if (!URI) {
    throw new Error("MONGODB_URI not set in .env — add it and restart");
  }

  // Prevent multiple simultaneous connection attempts
  if (_connecting) {
    await new Promise(r => setTimeout(r, 2000));
    return getDb();
  }

  _connecting = true;
  try {
    _client = new MongoClient(URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS:         10000,
    });
    await _client.connect();
    _db = _client.db(DB);
    console.log("✅ MongoDB connected");
    return _db;
  } catch (e) {
    _client = null;
    _db     = null;
    throw e;
  } finally {
    _connecting = false;
  }
}

export async function getMongoCollection(name) {
  const db = await getDb();
  return db.collection(name);
}
