import fetch from "node-fetch";

const NODES = [
  "https://api.protonnz.com",
  "https://proton.eosusa.io",
  "https://main.proton.kiwi",
];

const CONTRACT_CANDIDATES = ["sdex", "simpledex1", "protonswap", "swap.proton", "dex.proton", "proton.dex"];
const TABLE_CANDIDATES = ["pairs", "pools", "lpairs", "exchange", "markets"];

async function getTableRows(node, code, scope, table, limit = 3) {
  try {
    const res = await fetch(`${node}/v1/chain/get_table_rows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, scope, table, limit, json: true }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return data?.rows ?? [];
  } catch (e) {
    return [];
  }
}

async function getAccount(node, name) {
  try {
    const res = await fetch(`${node}/v1/chain/get_account`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_name: name }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

console.log("🔍 Checking which node is reachable...\n");

for (const node of NODES) {
  try {
    const res = await fetch(`${node}/v1/chain/get_info`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const info = await res.json();
      console.log(`✅ ${node} — chain: ${info.chain_id?.slice(0, 12)}...`);
    } else {
      console.log(`❌ ${node} — status ${res.status}`);
    }
  } catch (e) {
    console.log(`❌ ${node} — ${e.message}`);
  }
}

console.log("\n🔍 Searching for SimpleDEX contract...\n");

const node = NODES[0];

for (const contract of CONTRACT_CANDIDATES) {
  const account = await getAccount(node, contract);
  if (account) {
    console.log(`✅ Account EXISTS: ${contract}`);
    // Now check tables
    for (const table of TABLE_CANDIDATES) {
      const rows = await getTableRows(node, contract, contract, table, 2);
      if (rows.length) {
        console.log(`   ✅ Table found: ${table} — ${rows.length} rows`);
        console.log(`   Sample row:`, JSON.stringify(rows[0], null, 2));
      }
    }
  } else {
    console.log(`❌ Account not found: ${contract}`);
  }
}

console.log("\n✅ Debug complete.");
