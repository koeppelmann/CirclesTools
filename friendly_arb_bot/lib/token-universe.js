/**
 * On-chain token universe discovery for Circles CRC arb bot.
 * Discovers personal CRCs (backer group members) and groups (trusted by registry).
 * Resolves ERC20 wrappers and Balancer pool IDs.
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { getGroupMembers, getTrustedGroups } = require("./circles-rpc");

const CACHE_FILE = path.join(__dirname, "..", "data", "token-universe.json");

// Addresses
const BACKER_GROUP = "0x1aca75e38263c79d9d4f10df0635cc6fcfe6f026";
const GROUP_REGISTRY = "0x0aFd8899bca011Bb95611409f09c8EFbf6b169cF";
const GNOSIS_GROUP = "0xc19bc204eb1c1d5b3fe500e5e5dfabab625f286c";
const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";

const BAL_VAULT_ABI = [
  "function getPoolTokens(bytes32) view returns (address[], uint256[], uint256)",
  "function queryBatchSwap(uint8 kind, tuple(bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, tuple(address sender, bool fromInternalBalance, address payable recipient, bool toInternalBalance) funds) external returns (int256[])",
];

// Subgraph for Balancer pool discovery
const BAL_SUBGRAPH = "https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-gnosis-chain-v2";

/**
 * Discover the full token universe from on-chain data.
 * Returns { personal: [...], groups: [...] }
 */
async function discover(provider, log = console.log) {
  log("Discovering token universe...");

  // Load cache for pool IDs (expensive to re-discover)
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {}

  // 1. Discover groups trusted by registry
  const groupAddrs = await getTrustedGroups(GROUP_REGISTRY);
  log(`Found ${groupAddrs.length} groups from registry`);

  // 2. Discover personal CRCs from backer group
  const personalAddrs = await getGroupMembers(BACKER_GROUP);
  log(`Found ${personalAddrs.length} personal avatars from backer group`);

  const balVault = new ethers.Contract(
    "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    BAL_VAULT_ABI,
    provider
  );

  // 3. Resolve ERC20 wrappers and pools
  // Use cached pool IDs where available, query Balancer for new ones
  const poolCache = cache.poolIds || {};

  // Resolve groups
  const groups = [];
  for (const addr of groupAddrs) {
    const lc = addr.toLowerCase();
    if (lc === GNOSIS_GROUP.toLowerCase()) continue; // skip reference group
    const cached = poolCache[lc];
    if (cached) {
      groups.push({
        avatar: lc,
        erc20: cached.erc20,
        balPoolId: cached.balPoolId,
        type: "group",
      });
    }
  }

  // Resolve personal avatars
  const personal = [];
  for (const addr of personalAddrs) {
    const lc = addr.toLowerCase();
    const cached = poolCache[lc];
    if (cached) {
      personal.push({
        avatar: lc,
        erc20: cached.erc20,
        balPoolId: cached.balPoolId,
        baseToken: cached.baseToken || SDAI.toLowerCase(),
        baseSymbol: cached.baseSymbol || "sDAI",
        type: "personal",
      });
    }
  }

  log(`Resolved: ${personal.length} personal, ${groups.length} groups with known pools`);

  // 4. Query live Balancer prices for all tokens with pools
  // Use actual queryBatchSwap for 5 CRC to get real execution price (not misleading weighted spot)
  const PROBE_AMOUNT = ethers.parseEther("5"); // 5 CRC probe
  const ZERO_ADDR = "0x0000000000000000000000000000000000000001";
  const qfunds = { sender: ZERO_ADDR, fromInternalBalance: false, recipient: ZERO_ADDR, toInternalBalance: false };

  const allTokens = [...personal, ...groups];
  const batchSize = 20;
  for (let i = 0; i < allTokens.length; i += batchSize) {
    const batch = allTokens.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(async (token) => {
      try {
        const baseToken = token.baseToken || SDAI.toLowerCase();
        // Get reserves and execution price in parallel
        const [[tokens, balances], swapResult] = await Promise.all([
          balVault.getPoolTokens(token.balPoolId),
          balVault.queryBatchSwap.staticCall(
            0, [{ poolId: token.balPoolId, assetInIndex: 0n, assetOutIndex: 1n, amount: PROBE_AMOUNT, userData: "0x" }],
            [token.erc20, baseToken], qfunds,
          ).catch(() => null),
        ]);
        const baseIdx = tokens.findIndex(t => t.toLowerCase() === baseToken);
        const crcIdx = tokens.findIndex(t => t.toLowerCase() === token.erc20.toLowerCase());
        if (baseIdx >= 0 && crcIdx >= 0) {
          token.baseReserve = parseFloat(ethers.formatEther(balances[baseIdx]));
          token.crcReserve = parseFloat(ethers.formatEther(balances[crcIdx]));

          // Use execution price from queryBatchSwap (real price for 5 CRC sell)
          if (swapResult) {
            const baseOut = -parseFloat(ethers.formatEther(swapResult[1]));
            const execPrice = baseOut / 5; // base per CRC at execution
            if (baseToken === SDAI.toLowerCase()) {
              token.sdaiReserve = token.baseReserve;
              token.spotPrice = execPrice;
            } else {
              const GNO_PRICE = 122;
              const WETH_PRICE = 2500;
              const baseSymbol = token.baseSymbol || "";
              const multiplier = baseSymbol === "GNO" ? GNO_PRICE : baseSymbol === "WETH" ? WETH_PRICE : 1;
              token.sdaiReserve = token.baseReserve * multiplier;
              token.spotPrice = execPrice * multiplier;
            }
          } else {
            token.sdaiReserve = 0;
            token.spotPrice = 0;
          }
        }
      } catch {
        token.sdaiReserve = 0;
        token.spotPrice = 0;
      }
    }));
  }

  // Filter out tokens with no liquidity
  const activePersonal = personal.filter(t => t.sdaiReserve > 1);
  const activeGroups = groups.filter(t => t.sdaiReserve > 1);

  log(`Active pools: ${activePersonal.length} personal, ${activeGroups.length} groups`);

  return { personal: activePersonal, groups: activeGroups };
}

/**
 * Bootstrap pool cache from existing SQLite DB.
 * Call once to populate data/token-universe.json with pool IDs.
 */
function bootstrapFromDB(dbPath) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath);

  // Include sDAI, GNO, and WETH pools
  const rows = db.prepare(`
    SELECT LOWER(crc_avatar) as avatar, LOWER(crc_token) as erc20, pool_id, pool_type,
           LOWER(base_token) as base_token, base_symbol, total_liquidity
    FROM pools
    WHERE price_in_xdai > 0 AND total_liquidity > 1
  `).all();

  const poolIds = {};
  for (const r of rows) {
    const existing = poolIds[r.avatar];
    // Prefer sDAI pools, then highest liquidity GNO/WETH pool
    if (!existing ||
        (existing.baseToken !== SDAI.toLowerCase() && r.base_token === SDAI.toLowerCase()) ||
        (r.total_liquidity > (existing.liquidity || 0) && (r.base_token === existing.baseToken || existing.baseToken !== SDAI.toLowerCase()))) {
      poolIds[r.avatar] = {
        erc20: r.erc20,
        balPoolId: r.pool_id,
        baseToken: r.base_token,
        baseSymbol: r.base_symbol || "sDAI",
        liquidity: r.total_liquidity,
      };
    }
  }

  const cache = { poolIds, bootstrapTime: new Date().toISOString() };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  db.close();
  return Object.keys(poolIds).length;
}

module.exports = { discover, bootstrapFromDB, BACKER_GROUP, GROUP_REGISTRY, GNOSIS_GROUP };
