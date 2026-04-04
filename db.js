/**
 * DB - MongoDB connection
 */

import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://localhost:27017/xprbot";
const client = new MongoClient(MONGO_URI);

let dbInstance = null;

async function connect() {
  if (!dbInstance) {
    try {
      await client.connect();
      dbInstance = client.db(); // Uses the database named in the URI
      console.log("✅ Successfully connected to MongoDB.");
    } catch (error) {
      console.error("❌ Failed to connect to MongoDB:", error);
    }
  }
  return dbInstance;
}

export async function getMongoCollection(name) {
  const db = await connect();
  return db.collection(name);
}

export async function getDb() {
  return await connect();
}

