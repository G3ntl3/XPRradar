import fetch from "node-fetch";

const NODE = "https://api.protonnz.com";
const CONTRACT = "protonswap";

async function getTableRows(code, scope, table, limit = 3) {
  try {
    const res = await fetch(`${NODE}/v1/chain/get_table_rows`, {
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

// Get ABI to see all actual table names
async function getABI(account) {
  try {
    const res = await fetch(`${NODE}/v1/chain/get_abi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_name: account }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

console.log(`\n🔍 Fetching ABI for: ${CONTRACT}\n`);
const abi = await getABI(CONTRACT);

if (abi?.abi?.tables?.length) {
  console.log(`✅ Tables found in ABI:\n`);
  for (const table of abi.abi.tables) {
    console.log(`  📋 Table: "${table.name}" (type: ${table.type})`);
    // Try fetching rows from this table
    const rows = await getTableRows(CONTRACT, CONTRACT, table.name, 2);
    if (rows.length) {
      console.log(`     ✅ Has data! Sample row:`);
      console.log(JSON.stringify(rows[0], null, 4));
    } else {
      // Try with different scope
      const rows2 = await getTableRows(CONTRACT, "protonswap", table.name, 2);
      if (rows2.length) {
        console.log(`     ✅ Has data (scope=protonswap)! Sample:`);
        console.log(JSON.stringify(rows2[0], null, 4));
      } else {
        console.log(`     ⚠️  No rows returned`);
      }
    }
  }
} else {
  console.log("❌ No ABI tables found.");
  console.log("Raw ABI:", JSON.stringify(abi?.abi, null, 2));
}

// Also check Hyperion for recent swap actions
console.log(`\n🔍 Checking Hyperion for recent swaps on ${CONTRACT}...\n`);
try {
  const res = await fetch(
    `${NODE}/v2/history/get_actions?account=${CONTRACT}&limit=3&sort=desc`,
    { signal: AbortSignal.timeout(8000) }
  );
  const data = await res.json();
  if (data?.actions?.length) {
    console.log(`✅ Recent actions found:`);
    for (const action of data.actions) {
      console.log(`  Action: ${action.act?.name} | Data:`, JSON.stringify(action.act?.data, null, 2));
    }
  } else {
    console.log("⚠️ No recent actions found");
  }
} catch (e) {
  console.log("❌ Hyperion error:", e.message);
}

console.log("\n✅ Debug complete.");
