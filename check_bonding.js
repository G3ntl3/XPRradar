// Run: node check_bonding.js
// Prints full API response for an on-curve token so we can find the bonding progress field

import fetch from "node-fetch";

const res  = await fetch("https://indexer.protonnz.com/api/tokens?symbol=KARMA");
const data = await res.json();
const token = data?.tokens?.[0];

if (!token) {
  console.log("Token not found — try a different on-curve symbol");
} else {
  console.log("\n=== Full token fields ===\n");
  for (const [key, val] of Object.entries(token)) {
    console.log(`  ${key.padEnd(25)} = ${JSON.stringify(val)}`);
  }
}
