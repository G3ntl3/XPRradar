import fs from "fs";
import path from "path";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://localhost:27017/xprbot";
const client = new MongoClient(MONGO_URI);

async function migrate() {
  try {
    console.log("⏳ Connecting to MongoDB...");
    await client.connect();
    const db = client.db();
    console.log("✅ Connected.");

    const DATA_DIR = "./data";

    if (!fs.existsSync(DATA_DIR)) {
      console.log("❌ No data directory found. Nothing to migrate.");
      process.exit(0);
    }

    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));

    if (files.length === 0) {
      console.log("⚠️ No JSON files found in data directory.");
    }

    for (const file of files) {
      const collectionName = file.replace(".json", "");
      const filePath = path.join(DATA_DIR, file);
      
      console.log(`\n📦 Migrating ${file} to collection '${collectionName}'...`);
      
      const fileContent = fs.readFileSync(filePath, "utf8");
      if (!fileContent.trim()) continue;

      let docs;
      try {
        docs = JSON.parse(fileContent);
      } catch (err) {
        console.error(`❌ Failed to parse ${file}:`, err.message);
        continue;
      }

      if (!Array.isArray(docs)) {
        docs = [docs]; // Just in case it's a single object
      }

      if (docs.length === 0) {
        console.log(`⚠️ ${file} is empty, skipping.`);
        continue;
      }

      const collection = db.collection(collectionName);
      
      // Before inserting, let's clear the existing collection to prevent duplicates if ran twice, 
      // or we can just try to insert one by one preventing duplicate _id.
      // We will loop and use upsert by _id or just insert.
      
      let inserted = 0;
      let alreadyExists = 0;

      for (const doc of docs) {
        // If the doc doesn't have an _id, MongoDB will generate one
        const filter = doc._id ? { _id: doc._id } : doc; 
        
        // Let's just do a replaceOne with upsert to be fully safe
        if (doc._id) {
            await collection.replaceOne({ _id: doc._id }, doc, { upsert: true });
            inserted++;
        } else {
            // Check if it already exists by a logical key (optional, depends on your schema),
            // else just insert. Assuming JSON had _ids or we just insert them.
            await collection.insertOne(doc);
            inserted++;
        }
      }

      console.log(`✅ Migrated ${inserted} records into '${collectionName}'.`);
    }

    console.log("\n🎉 Migration Complete!");
  } catch (err) {
    console.error("❌ Migration failed:", err);
  } finally {
    await client.close();
    process.exit(0);
  }
}

migrate();
