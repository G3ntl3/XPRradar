/**
 * DB — JSON file storage fallback
 * Replaces MongoDB with local JSON files
 * Drop-in replacement — same API as MongoDB version
 */

import fs from "fs";
import path from "path";

const DATA_DIR = "./data";

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function filePath(collection) {
  return path.join(DATA_DIR, `${collection}.json`);
}

function readCollection(collection) {
  const fp = filePath(collection);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {}
  return [];
}

function writeCollection(collection, data) {
  fs.writeFileSync(filePath(collection), JSON.stringify(data, null, 2));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      // Handle simple operators
      if (v.$ne !== undefined) return doc[k] !== v.$ne;
    }
    return doc[k] === v;
  });
}

// ─── Collection class — mimics MongoDB collection API ─────────────────────────

class JsonCollection {
  constructor(name) {
    this.name = name;
  }

  async findOne(filter) {
    const docs = readCollection(this.name);
    return docs.find(d => matchesFilter(d, filter)) ?? null;
  }

  async find(filter = {}) {
    const docs = readCollection(this.name);
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
    const docs = readCollection(this.name);
    const newDoc = { _id: generateId(), ...doc };
    docs.push(newDoc);
    writeCollection(this.name, docs);
    return { insertedId: newDoc._id };
  }

  async updateOne(filter, update) {
    const docs  = readCollection(this.name);
    const idx   = docs.findIndex(d => matchesFilter(d, filter));
    if (idx === -1) return { matchedCount: 0 };
    if (update.$set) Object.assign(docs[idx], update.$set);
    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        if (!docs[idx][k]) docs[idx][k] = [];
        docs[idx][k].push(v);
      }
    }
    writeCollection(this.name, docs);
    return { matchedCount: 1 };
  }

  async deleteOne(filter) {
    const docs  = readCollection(this.name);
    const idx   = docs.findIndex(d => matchesFilter(d, filter));
    if (idx === -1) return { deletedCount: 0 };
    docs.splice(idx, 1);
    writeCollection(this.name, docs);
    return { deletedCount: 1 };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

const _collections = {};

export async function getMongoCollection(name) {
  if (!_collections[name]) _collections[name] = new JsonCollection(name);
  return _collections[name];
}

export async function getDb() {
  return { collection: (name) => new JsonCollection(name) };
}
