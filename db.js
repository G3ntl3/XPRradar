/**
 * DB - MongoDB connection with High-Speed RAM Cache
 * Provides 0ms latency for bot transactions with background DB persistence.
 */

import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://localhost:27017/xprbot";
const client = new MongoClient(MONGO_URI);

let dbInstance = null;
const cache = {}; // In-memory data store

async function connect() {
  if (!dbInstance) {
    try {
      await client.connect();
      dbInstance = client.db();
      console.log("✅ Successfully connected to MongoDB.");
      
      // Preload critical collections into RAM
      cache['wallets'] = await dbInstance.collection('wallets').find().toArray();
      cache['positions'] = await dbInstance.collection('positions').find().toArray();
      console.log(`⚡ RAM Cache loaded: ${cache['wallets'].length} wallets, ${cache['positions'].length} positions.`);
    } catch (error) {
      console.error("❌ Failed to connect to MongoDB:", error);
    }
  }
  return dbInstance;
}

// Ensure connection starts immediately on boot
const dbReadyPromise = connect();

// Helper to simulate MongoDB queries in memory
function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (v.$ne !== undefined) return doc[k] !== v.$ne;
    }
    return doc[k] === v;
  });
}

class CachedCollection {
  constructor(name, mongoCollection) {
    this.name = name;
    this.mongo = mongoCollection;
  }

  async findOne(filter) {
    const docs = cache[this.name] || [];
    // Read from memory (instant)
    return docs.find(d => matchesFilter(d, filter)) ?? null;
  }

  find(filter = {}) {
    const docs = cache[this.name] || [];
    const results = docs.filter(d => matchesFilter(d, filter));
    return {
      toArray: async () => results,
      sort: (s) => ({
        limit: (n) => ({
          toArray: async () => {
            const key  = Object.keys(s)[0];
            const dir  = s[key];
            return [...results]
              .sort((a, b) => dir === -1 ? (b[key] > a[key] ? 1 : -1) : (a[key] > b[key] ? 1 : -1))
              .slice(0, n);
          }
        }),
        toArray: async () => results
      }),
      limit: (n) => ({ toArray: async () => results.slice(0, n) }),
    };
  }

  async insertOne(doc) {
    if (!cache[this.name]) cache[this.name] = [];
    const newDoc = { _id: new ObjectId().toString(), ...doc };
    
    // 1. Update memory instantly
    cache[this.name].push(newDoc);
    
    // 2. Background async write to Mongo (non-blocking)
    this.mongo.insertOne(newDoc).catch(e => console.error(`❌ Background MongoDB insert failed [${this.name}]:`, e));
    
    return { insertedId: newDoc._id };
  }

  async updateOne(filter, update) {
    const docs = cache[this.name] || [];
    const idx = docs.findIndex(d => matchesFilter(d, filter));
    let matchedCount = 0;

    // 1. Update memory instantly
    if (idx !== -1) {
      matchedCount = 1;
      if (update.$set) Object.assign(docs[idx], update.$set);
      if (update.$push) {
        for (const [k, v] of Object.entries(update.$push)) {
          if (!docs[idx][k]) docs[idx][k] = [];
          docs[idx][k].push(v);
        }
      }
    }

    // 2. Background async write to Mongo (non-blocking) - We use upsert=true for safety
    if (update.$set || update.$push) {
       this.mongo.updateOne(filter, update, { upsert: true }).catch(e => console.error(`❌ Background MongoDB update failed [${this.name}]:`, e));
    }

    return { matchedCount };
  }

  async deleteOne(filter) {
    const docs = cache[this.name] || [];
    const idx = docs.findIndex(d => matchesFilter(d, filter));
    let deletedCount = 0;

    // 1. Update memory instantly
    if (idx !== -1) {
      deletedCount = 1;
      docs.splice(idx, 1);
    }

    // 2. Background async write to Mongo (non-blocking)
    this.mongo.deleteOne(filter).catch(e => console.error(`❌ Background MongoDB delete failed [${this.name}]:`, e));

    return { deletedCount };
  }
}

export async function getMongoCollection(name) {
  const db = await dbReadyPromise;
  
  // If a new collection is requested that hasn't been cached yet, load it once
  if (!cache[name]) {
    cache[name] = await db.collection(name).find().toArray();
  }
  
  return new CachedCollection(name, db.collection(name));
}

export async function getDb() {
  return await dbReadyPromise;
}
