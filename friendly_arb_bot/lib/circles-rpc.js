const { ethers } = require("ethers");

const RPC_URLS = [
  "https://rpc.aboutcircles.com",
  "https://rpc.circlesubi.network/",
];

let activeRpcIdx = 0;

async function rpcCall(method, params) {
  for (let attempt = 0; attempt < RPC_URLS.length; attempt++) {
    const idx = (activeRpcIdx + attempt) % RPC_URLS.length;
    const url = RPC_URLS[idx];
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      const text = await r.text();
      if (!text) throw new Error(`Empty response from ${url}`);
      const j = JSON.parse(text);
      if (j.error) {
        if (j.error.code === -32602) throw new Error(`RPC ${method}: ${j.error.message}`);
        throw new Error(`RPC ${method}: ${j.error.message}`);
      }
      activeRpcIdx = idx;
      return j.result;
    } catch (e) {
      if (attempt === RPC_URLS.length - 1) throw e;
    }
  }
}

/**
 * Get holders of a CRC token (by avatar/token address).
 */
async function getHolders(tokenAddress, limit = 20) {
  const result = await rpcCall("circles_query", [{
    Namespace: "V_CrcV2",
    Table: "BalancesByAccountAndToken",
    Columns: [],
    Filter: [{
      Type: "FilterPredicate",
      FilterType: "Equals",
      Column: "tokenAddress",
      Value: tokenAddress.toLowerCase(),
    }],
    Order: [{ Column: "demurragedTotalBalance", SortOrder: "DESC" }],
    Limit: limit,
  }]);
  return (result?.rows || []).map(([account, tokenId, tokenAddr, lastActivity, totalBal, demBal]) => ({
    account,
    totalBalance: BigInt(totalBal),
    demurragedBalance: BigInt(demBal),
  }));
}

/**
 * Find a path from source to sink.
 * Always tries aboutcircles.com first (better pathfinder), falls back to circlesubi.
 * NOTE: FromTokens/ToTokens are NOT passed - they cause 500 errors on aboutcircles.
 */
async function findPath({ source, sink, targetFlow, fromTokens, toTokens, simulatedBalances, maxTransfers = 15, withWrap = false }) {
  const ABOUTCIRCLES_URL = "https://rpc.aboutcircles.com";
  const CIRCLESUBI_URL = "https://rpc.circlesubi.network/";

  const needsTokenFilter = !!(fromTokens || toTokens);

  // aboutcircles.com: better pathfinder but crashes with FromTokens/ToTokens (500 error)
  // Only use when no token filters are needed (e.g., group arb)
  if (!needsTokenFilter) {
    try {
      const ucParams = {
        Source: source,
        Sink: sink,
        TargetFlow: targetFlow.toString(),
        WithWrap: withWrap,
        MaxTransfers: String(maxTransfers),
      };
      if (simulatedBalances) ucParams.SimulatedBalances = simulatedBalances;

      const r = await fetch(ABOUTCIRCLES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "circlesV2_findPath", params: [ucParams] }),
        signal: AbortSignal.timeout(15000),
      });
      const text = await r.text();
      if (!text) throw new Error("Empty response");
      const j = JSON.parse(text);
      if (j.error) throw new Error(`RPC circlesV2_findPath: ${j.error.message}`);
      return j.result;
    } catch {
      // aboutcircles down, fall through to circlesubi
    }
  }

  // circlesubi.network: supports token filters (needed for personal arb)
  const lcParams = {
    source,
    sink,
    targetFlow: targetFlow.toString(),
    maxTransfers: parseInt(maxTransfers),
  };
  if (fromTokens) lcParams.fromTokens = fromTokens;
  if (toTokens) lcParams.toTokens = toTokens;
  if (simulatedBalances) lcParams.simulatedBalances = simulatedBalances;

  try {
    const r = await fetch(CIRCLESUBI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "circlesV2_findPath", params: [lcParams] }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    if (!text) throw new Error("Empty response from circlesubi");
    const j = JSON.parse(text);
    if (j.error) throw new Error(`RPC circlesV2_findPath: ${j.error.message}`);
    return j.result;
  } catch (e) {
    // If circlesubi fails WITH token filters, fall back to aboutcircles WITHOUT filters
    // (aboutcircles crashes with token filters but works fine without them)
    if (!needsTokenFilter) throw e;

    const ucParams = {
      Source: source,
      Sink: sink,
      TargetFlow: targetFlow.toString(),
      WithWrap: withWrap,
      MaxTransfers: String(maxTransfers),
    };
    if (simulatedBalances) ucParams.SimulatedBalances = simulatedBalances;

    const r = await fetch(ABOUTCIRCLES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "circlesV2_findPath", params: [ucParams] }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    if (!text) throw new Error("Empty response from aboutcircles fallback");
    const j = JSON.parse(text);
    if (j.error) throw new Error(`RPC circlesV2_findPath fallback: ${j.error.message}`);
    return j.result;
  }
}

/**
 * Get members of a group.
 */
async function getGroupMembers(groupAddress, limit = 1000) {
  const result = await rpcCall("circles_query", [{
    Namespace: "V_CrcV2",
    Table: "GroupMemberships",
    Columns: [],
    Filter: [{
      Type: "FilterPredicate",
      FilterType: "Equals",
      Column: "group",
      Value: groupAddress.toLowerCase(),
    }],
    Limit: limit,
  }]);
  const cols = result?.columns || [];
  const memberIdx = cols.indexOf("member");
  return (result?.rows || []).map(r => r[memberIdx]);
}

/**
 * Get groups trusted by an address (org/registry).
 */
async function getTrustedGroups(trusterAddress, limit = 200) {
  const result = await rpcCall("circles_query", [{
    Namespace: "V_CrcV2",
    Table: "TrustRelations",
    Columns: [],
    Filter: [{
      Type: "FilterPredicate",
      FilterType: "Equals",
      Column: "truster",
      Value: trusterAddress.toLowerCase(),
    }],
    Limit: limit,
  }]);
  const cols = result?.columns || [];
  const trusteeIdx = cols.indexOf("trustee");
  return (result?.rows || []).map(r => r[trusteeIdx]);
}

module.exports = { rpcCall, getHolders, findPath, getGroupMembers, getTrustedGroups };
