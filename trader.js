/**
 * Trader — signs and pushes buy/sell transactions to simplelaunch contract
 *
 * Buy action:  { buyer, tokenId, minTokens }
 *   XPR amount is sent as eosio.token transfer TO simplelaunch
 *   with memo "buy:<tokenId>"
 *
 * Sell action: { seller, tokenId, tokenAmount, minXpr }
 */

import { Api, JsonRpc } from "eosjs";
import { JsSignatureProvider } from "eosjs/dist/eosjs-jssig.js";
import fetch from "node-fetch";
import { getPrivateKey } from "./wallet.js";

const RPC_ENDPOINT    = "https://api.protonnz.com";
const CONTRACT        = "simplelaunch";
const XPR_CONTRACT    = "eosio.token";
const XPR_SYMBOL      = "XPR";
const XPR_DECIMALS    = 4;

// Master account — pays for new account creation
// Set in .env: MASTER_ACCOUNT and MASTER_PRIVATE_KEY
const MASTER_ACCOUNT  = process.env.MASTER_ACCOUNT;
const MASTER_KEY      = process.env.MASTER_PRIVATE_KEY;

function getRpc() {
  return new JsonRpc(RPC_ENDPOINT, { fetch });
}

function getApi(privateKeyWif) {
  const rpc = getRpc();
  const sig = new JsSignatureProvider([privateKeyWif]);
  return new Api({ rpc, signatureProvider: sig, textEncoder: new TextEncoder(), textDecoder: new TextDecoder() });
}

// Format XPR amount: 5 → "5.0000 XPR"
function fmtXpr(amount) {
  return `${parseFloat(amount).toFixed(XPR_DECIMALS)} ${XPR_SYMBOL}`;
}

// Raw token amount for sell: tokens * 10^precision
function rawTokenAmount(amount, precision = 4) {
  return Math.floor(parseFloat(amount) * Math.pow(10, precision));
}

// ─── Create XPR account on-chain ─────────────────────────────────────────────
// Master account pays RAM + account creation fees
// newAccountName must be 12 chars, lowercase a-z, 1-5 only

export async function createXprAccount(newAccountName, ownerPublicKey) {
  if (!MASTER_ACCOUNT || !MASTER_KEY) {
    throw new Error("MASTER_ACCOUNT or MASTER_PRIVATE_KEY not set in .env");
  }

  const api = getApi(MASTER_KEY);

  const result = await api.transact({
    actions: [
      // Create the account
      {
        account:       "eosio",
        name:          "newaccount",
        authorization: [{ actor: MASTER_ACCOUNT, permission: "active" }],
        data: {
          creator: MASTER_ACCOUNT,
          name:    newAccountName,
          owner: {
            threshold: 1,
            keys: [{ key: ownerPublicKey, weight: 1 }],
            accounts: [],
            waits: [],
          },
          active: {
            threshold: 1,
            keys: [{ key: ownerPublicKey, weight: 1 }],
            accounts: [],
            waits: [],
          },
        },
      },
      // Buy RAM for the new account (4096 bytes = enough for basic account)
      {
        account:       "eosio",
        name:          "buyrambytes",
        authorization: [{ actor: MASTER_ACCOUNT, permission: "active" }],
        data: {
          payer:    MASTER_ACCOUNT,
          receiver: newAccountName,
          bytes:    4096,
        },
      },
    ],
  }, {
    blocksBehind:  3,
    expireSeconds: 30,
  });

  return result;
}

// ─── Get XPR balance ──────────────────────────────────────────────────────────

export async function getXprBalance(accountName) {
  try {
    const res = await fetch(`${RPC_ENDPOINT}/v1/chain/get_currency_balance`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ code: XPR_CONTRACT, account: accountName, symbol: XPR_SYMBOL }),
      signal:  AbortSignal.timeout(8000),
    });
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return 0;
    return parseFloat(rows[0].split(" ")[0]);
  } catch (e) {
    console.warn("getXprBalance error:", e.message);
    return 0;
  }
}

// ─── Get token balance ────────────────────────────────────────────────────────

export async function getTokenBalance(accountName, symbol, contract = "eosio.token") {
  try {
    const rpc  = getRpc();
    // Try simplelaunch contract first (bonding curve tokens)
    const rows = await rpc.get_currency_balance(CONTRACT, accountName, symbol)
      .catch(() => []);
    if (rows?.length) return parseFloat(rows[0].split(" ")[0]);
    // Fallback to standard token contract
    const rows2 = await rpc.get_currency_balance(contract, accountName, symbol)
      .catch(() => []);
    if (rows2?.length) return parseFloat(rows2[0].split(" ")[0]);
    return 0;
  } catch {
    return 0;
  }
}

// ─── Buy tokens ───────────────────────────────────────────────────────────────
// Buy = transfer XPR to simplelaunch with memo "buy:<tokenId>"
// The contract's buy action is triggered by the transfer memo

export async function buyTokens({ userId, accountName, tokenId, xprAmount }) {
  const privateKey = await getPrivateKey(userId);
  if (!privateKey) throw new Error("No wallet found for user");

  const api = getApi(privateKey);

  const result = await api.transact({
    actions: [
      // Step 1: Transfer XPR to contract (triggers buy)
      {
        account:       XPR_CONTRACT,
        name:          "transfer",
        authorization: [{ actor: accountName, permission: "active" }],
        data: {
          from:     accountName,
          to:       CONTRACT,
          quantity: fmtXpr(xprAmount),
          memo:     `buy:${tokenId}`,
        },
      },
    ],
  }, {
    blocksBehind:     3,
    expireSeconds:    30,
  });

  return result;
}

// ─── Sell tokens ──────────────────────────────────────────────────────────────

export async function sellTokens({ userId, accountName, tokenId, tokenAmount, precision = 4 }) {
  const privateKey = await getPrivateKey(userId);
  if (!privateKey) throw new Error("No wallet found for user");

  const api = getApi(privateKey);

  const rawAmount = rawTokenAmount(tokenAmount, precision);

  const result = await api.transact({
    actions: [
      {
        account:       CONTRACT,
        name:          "sell",
        authorization: [{ actor: accountName, permission: "active" }],
        data: {
          seller:      accountName,
          tokenId:     tokenId,
          tokenAmount: rawAmount,
          minXpr:      0,   // no slippage protection (0 = accept any price)
        },
      },
    ],
  }, {
    blocksBehind:   3,
    expireSeconds:  30,
  });

  return result;
}

// ─── Get all token balances for account ───────────────────────────────────────

export async function getAllBalances(accountName) {
  try {
    const rpc = getRpc();
    const xpr = await getXprBalance(accountName);

    // Get all currency balances from simplelaunch (bonding curve tokens)
    const account = await rpc.get_account(accountName).catch(() => null);

    return { xpr, account };
  } catch (e) {
    console.warn("getAllBalances error:", e.message);
    return { xpr: 0 };
  }
}
