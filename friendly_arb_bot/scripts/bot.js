#!/usr/bin/env node
// Autonomous Circles CRC Arbitrage Bot v2
// Discovers tokens on-chain, arbs personal + group CRC against Gnosis group reference price
// Buy Gnosis CRC on UniV3, convert via trust graph, sell on Balancer

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { buildFlowMatrix } = require("../lib/flow-matrix");
const { findPath, getHolders, rpcCall } = require("../lib/circles-rpc");
const { discover } = require("../lib/token-universe");

// ============================================================================
// CONFIG
// ============================================================================
const CONFIG = {
  LOOP_INTERVAL_MS: 30_000,       // 30s between cycles
  SLOW_INTERVAL_MS: 120_000,      // 2min when idle
  IDLE_THRESHOLD: 10,             // cycles without trade before slowing
  MIN_PROFIT_SDAI: 0.01,
  SAFETY_MARGINS: [0.90, 0.75, 0.60],
  DEMURRAGE_FACTOR: 0.676,
  MAX_SPEND_FRACTION: 0.50,          // max fraction of sDAI balance per trade
  FAIL_COOLDOWN_MS: 1_800_000,    // 30 min on failure
  SUCCESS_COOLDOWN_MS: 30_000,    // 30s on success
  PF_TARGET_FLOW: "5000",
  PF_MAX_TRANSFERS: 2,
  PF_CACHE_TTL_MS: 300_000,       // 5 min cache
  UNIVERSE_REFRESH_MS: 3_600_000,  // 1 hour

  SAFE: "0x3F4cCACf2173553850258dE2E8495366a0F10c31",
  CONTRACT: "0x79F281B346204B7af83D9ec5C2251376e170e43f",
  CONTRACT_OLD: "0x78a428E2A17087965ac9F55b8C1418A9C4fCB358",
  MULTI_SEND: "0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761",
  SDAI: "0xaf204776c7245bF4147c2612BF6e5972Ee483701",
  UNI_POOL: "0x582F85E3fDd6EfE0CcF71D1fa6b1B87d8e64CE7d",
  HUB: "0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8",
  BAL_VAULT: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  GNOSIS_GROUP: "0xc19bc204eb1c1d5b3fe500e5e5dfabab625f286c",
  GNOSIS_GROUP_ERC20: "0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A",
  WXDAI: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
  GNO: "0x9c58bacc331c9aa871afd802db6379a98e80cedb",
  WETH: "0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1",
  GNO_WXDAI_POOL: "0x8189c4c96826d016a99fdca0c5ae6b678c85a97200020000000000000000004b",
  WETH_WXDAI_POOL: "0x2bae47cc09b29408abbc558ff3cb5e8ff5db583100020000000000000000004c",
  GNOSIS_RPC: "https://rpc.gnosischain.com",

  // Group arb config
  GROUP_ARB: {
    TARGET_SPREAD: 0.04,           // 4% target spread
    MIN_PROFIT_SDAI: 0.3,
    PF_MAX_TRANSFERS: 15,
    COOLDOWN_MS: 120_000,
    SPEND_BUFFER: 1.03,
    TEST_SIZES: [500, 1000, 2000, 3000, 5000, 7000, 9000, 12000],
    // Mint handlers: map group avatar → mint handler address
    // The mint handler has wider trust (accepts more personal CRC) than the group itself
    MINT_HANDLERS: {
      "0x3d12046d3d2de60b6de71ad30e289080ff52052d": "0xf9117e9931E6ab91f025e1afa4e70CAFa5E0AA1E",
    },
  },

  // Safety
  MAX_HOURLY_LOSS: 5.0,           // halt if losing >5 sDAI/hour
  BALANCE_FLOOR: 1.0,             // never trade below 1 sDAI

  // Profit accumulation: convert excess sDAI → Gnosis CRC
  ACCUMULATE: {
    ENABLED: true,
    SDAI_WORKING_BALANCE: 20.0,   // keep this much sDAI for trading
    MIN_CONVERT_AMOUNT: 0.5,      // don't convert less than this (gas efficiency)
    SWAP_ROUTER: "0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be", // UniV3 SwapRouter02 on Gnosis
    UNI_FEE: 10000,               // 1% fee tier for sDAI/CRC pool
  },
};

// ============================================================================
// GLOBALS
// ============================================================================
const provider = new ethers.JsonRpcProvider(CONFIG.GNOSIS_RPC);
const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error("Set PRIVATE_KEY env var"); process.exit(1); }
const wallet = new ethers.Wallet(PK, provider);

const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "contracts", "AtomicPersonalArb.json")));
const contract = new ethers.Contract(CONFIG.CONTRACT, artifact.abi, wallet);

const sdaiToken = new ethers.Contract(CONFIG.SDAI, [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
], wallet);

const hub = new ethers.Contract(CONFIG.HUB, [
  "function isTrusted(address truster, address trustee) view returns (bool)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function treasuries(address group) view returns (address)",
  "function isHuman(address) view returns (bool)",
], provider);

// Cache of isHuman checks (address -> bool)
const humanCache = new Map();

const balVault = new ethers.Contract(CONFIG.BAL_VAULT, [
  "function queryBatchSwap(uint8 kind, tuple(bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, tuple(address sender, bool fromInternalBalance, address payable recipient, bool toInternalBalance) funds) external returns (int256[])",
  "function getPoolTokens(bytes32) view returns (address[], uint256[], uint256)",
], provider);

const uniPool = new ethers.Contract(CONFIG.UNI_POOL, [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
], provider);

const gnosisCrcToken = new ethers.Contract(CONFIG.GNOSIS_GROUP_ERC20, [
  "function balanceOf(address) view returns (uint256)",
], provider);

const swapRouter = new ethers.Contract(CONFIG.ACCUMULATE.SWAP_ROUTER, [
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
], wallet);

const safe = new ethers.Contract(CONFIG.SAFE, [
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) public view returns (bytes32)",
  "function nonce() public view returns (uint256)",
], wallet);

const multiSendIface = new ethers.Interface([
  "function multiSend(bytes memory transactions) public payable",
]);

// Encode a single tx for MultiSend packed format
function encodeMultiSendTx(to, data, operation = 0, value = 0n) {
  const dataBytes = ethers.getBytes(data);
  return ethers.solidityPacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [operation, to, value, dataBytes.length, dataBytes]
  );
}

// Execute a Safe transaction (EOA is sole owner, threshold=1)
async function execSafeTx(to, data, operation = 0, gasLimit = 3_000_000) {
  const nonce = await safe.nonce();
  const txHash = await safe.getTransactionHash(
    to, 0n, data, operation,
    0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce
  );
  const sig = wallet.signingKey.sign(txHash);
  const signature = ethers.solidityPacked(
    ["bytes32", "bytes32", "uint8"],
    [sig.r, sig.s, sig.v]
  );
  return safe.execTransaction(
    to, 0n, data, operation,
    0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signature,
    { gasLimit }
  );
}

// Execute multiple calls via Safe MultiSend (bundled in 1 tx)
async function execSafeMultiSend(txs, gasLimit = 3_000_000) {
  const encoded = ethers.concat(txs.map(t => encodeMultiSendTx(t.to, t.data, t.op || 0, t.value || 0n)));
  const data = multiSendIface.encodeFunctionData("multiSend", [encoded]);
  return execSafeTx(CONFIG.MULTI_SEND, data, 1, gasLimit); // operation=1 = delegatecall
}

// Simulate a Safe MultiSend via staticCall
async function simulateSafeMultiSend(txs) {
  const encoded = ethers.concat(txs.map(t => encodeMultiSendTx(t.to, t.data, t.op || 0, t.value || 0n)));
  const data = multiSendIface.encodeFunctionData("multiSend", [encoded]);
  const nonce = await safe.nonce();
  const txHash = await safe.getTransactionHash(
    CONFIG.MULTI_SEND, 0n, data, 1,
    0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce
  );
  const sig = wallet.signingKey.sign(txHash);
  const signature = ethers.solidityPacked(
    ["bytes32", "bytes32", "uint8"],
    [sig.r, sig.s, sig.v]
  );
  return safe.execTransaction.staticCall(
    CONFIG.MULTI_SEND, 0n, data, 1,
    0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signature,
    { gasLimit: 3_000_000 }
  );
}

const qfunds = {
  sender: CONFIG.SAFE, fromInternalBalance: false,
  recipient: CONFIG.SAFE, toInternalBalance: false,
};

// State
const STATE_FILE = path.join(__dirname, "..", "data", "bot-state.json");
const HEARTBEAT_FILE = path.join(__dirname, "..", "data", "heartbeat");
let state = {
  startTime: Date.now(),
  totalProfit: 0,
  totalTrades: 0,
  totalFailed: 0,
  totalCrcAccumulated: 0,
  totalSdaiConverted: 0,
  trades: [],
  trustedAddrs: new Set(),
  lastConfiguredTarget: null,
  poolCooldowns: {},
};

// Caches
let cachedUniRate = null;
let cachedUniRateTime = 0;
const pfCache = new Map();
let cachedHolder = null;
let cachedHolderTime = 0;
let lastGroupArbTimes = {}; // per-group cooldown

// Token universe
let universe = null;
let universeRefreshTime = 0;
let idleCycles = 0;

// ============================================================================
// LOGGING
// ============================================================================
const LOG_FILE = path.join(__dirname, "..", "data", "bot.log");

function log(level, component, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { info: " ", warn: "!", error: "X", trade: "$" }[level] || " ";
  const line = `[${ts}] ${prefix} [${component}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
  if (process.stdout.isTTY) console.log(line);
}

function rotateLog() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > 2_000_000) { // 2MB
        const bak = LOG_FILE + ".1";
        if (fs.existsSync(bak)) fs.unlinkSync(bak);
        fs.renameSync(LOG_FILE, bak);
      }
    }
  } catch {}
}

// ============================================================================
// STATE
// ============================================================================
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      state.totalProfit = saved.totalProfit || 0;
      state.totalTrades = saved.totalTrades || 0;
      state.totalFailed = saved.totalFailed || 0;
      state.totalCrcAccumulated = saved.totalCrcAccumulated || 0;
      state.totalSdaiConverted = saved.totalSdaiConverted || 0;
      state.totalCrcGivenBack = saved.totalCrcGivenBack || 0;
      state.trades = saved.trades || [];
      state.trustedAddrs = new Set(saved.trustedAddrs || []);
      state.lastConfiguredTarget = saved.lastConfiguredTarget || null;
      const rawCd = saved.poolCooldowns || {};
      state.poolCooldowns = {};
      for (const [k, v] of Object.entries(rawCd)) {
        state.poolCooldowns[k] = typeof v === "number" ? { time: v, failed: true } : v;
      }
      log("info", "state", `Loaded: ${state.totalTrades} trades, ${state.totalProfit.toFixed(4)} sDAI profit, ${state.totalCrcAccumulated.toFixed(1)} CRC accumulated`);
    }
  } catch (e) {
    log("warn", "state", "Could not load state: " + e.message);
  }
}

function saveState() {
  try {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      ...state,
      trustedAddrs: [...state.trustedAddrs],
      trades: state.trades.slice(-500),
    }, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
}

function writeHeartbeat() {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({
      time: new Date().toISOString(),
      trades: state.totalTrades,
      profit: state.totalProfit,
      crcAccumulated: state.totalCrcAccumulated,
      sdaiConverted: state.totalSdaiConverted,
      universe: universe ? { personal: universe.personal.length, groups: universe.groups.length } : null,
    }));
  } catch {}
}

// ============================================================================
// UNIV3 RATE
// ============================================================================
async function getUniV3Rate() {
  const now = Date.now();
  if (cachedUniRate && now - cachedUniRateTime < 30_000) return cachedUniRate;
  const slot0Data = await uniPool.slot0();
  const price = Number(slot0Data.sqrtPriceX96) / (2 ** 96);
  cachedUniRate = price * price;
  cachedUniRateTime = now;
  return cachedUniRate;
}

// ============================================================================
// BALANCER QUOTE
// ============================================================================
async function getBalancerSellQuote(poolId, sCrcToken, amountCrc) {
  try {
    const crcWei = ethers.parseEther(amountCrc.toFixed(8));
    const result = await balVault.queryBatchSwap.staticCall(
      0, [{ poolId, assetInIndex: 0n, assetOutIndex: 1n, amount: crcWei, userData: "0x" }],
      [sCrcToken, CONFIG.SDAI], qfunds,
    );
    return -parseFloat(ethers.formatEther(result[1]));
  } catch {
    return null;
  }
}

// SushiSwap router for GNO/WETH → WXDAI relay quotes
const sushiRouter = new ethers.Contract("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", [
  "function getAmountsOut(uint256, address[]) view returns (uint256[])",
], provider);

// Cross-base quote: CRC → GNO/WETH (Balancer) → WXDAI (SushiSwap) → sDAI
async function getCrossBaseSellQuote(poolId, crcToken, baseToken, relayPoolId, amountCrc) {
  try {
    const crcWei = ethers.parseEther(amountCrc.toFixed(8));
    // Step 1: CRC → GNO/WETH on Balancer
    const balResult = await balVault.queryBatchSwap.staticCall(
      0, [{ poolId, assetInIndex: 0n, assetOutIndex: 1n, amount: crcWei, userData: "0x" }],
      [crcToken, baseToken], qfunds,
    );
    const baseOut = -balResult[1];
    if (baseOut <= 0n) return null;

    // Step 2: GNO/WETH → WXDAI on SushiSwap
    const sushiResult = await sushiRouter.getAmountsOut(baseOut, [baseToken, CONFIG.WXDAI]);
    const wxdaiOut = parseFloat(ethers.formatEther(sushiResult[1]));
    if (wxdaiOut <= 0) return null;

    // Step 3: WXDAI → sDAI (ERC4626 rate)
    if (!cachedSdaiRate || Date.now() - cachedSdaiRateTime > 60_000) {
      const sdaiVault = new ethers.Contract(CONFIG.SDAI, ["function convertToShares(uint256) view returns (uint256)"], provider);
      const shares = await sdaiVault.convertToShares(ethers.parseEther("1"));
      cachedSdaiRate = parseFloat(ethers.formatEther(shares));
      cachedSdaiRateTime = Date.now();
    }
    return wxdaiOut * cachedSdaiRate;
  } catch {
    return null;
  }
}
let cachedSdaiRate = null, cachedSdaiRateTime = 0;

// ============================================================================
// HOLDER CACHE (Gnosis group CRC holders for pathfinder source)
// ============================================================================
async function getHolder() {
  const now = Date.now();
  if (cachedHolder && now - cachedHolderTime < 120_000) return cachedHolder;
  const holders = await getHolders(CONFIG.GNOSIS_GROUP, 10);
  // Pathfinder requires source to be a registered Circles account (human or org)
  // Filter out ERC20 wrappers, our contract, and non-Circles addresses
  for (const h of holders) {
    if (h.account === CONFIG.GNOSIS_GROUP_ERC20.toLowerCase()) continue;
    if (h.account === CONFIG.CONTRACT.toLowerCase()) continue;
    try {
      const res = await rpcCall("circles_query", [{
        Namespace: "V_CrcV2",
        Table: "Avatars",
        Columns: [],
        Filter: [{ Type: "FilterPredicate", FilterType: "Equals", Column: "avatar", Value: h.account }],
        Limit: 1,
      }]);
      if (res?.rows?.length > 0) {
        cachedHolder = h;
        cachedHolderTime = now;
        log("info", "holder", `Using ${h.account.slice(0,10)} (Circles account, ${(Number(h.demurragedBalance) / 1e18).toFixed(0)} CRC)`);
        return cachedHolder;
      }
    } catch {}
  }
  log("warn", "holder", "No Circles account found among Gnosis CRC holders");
  cachedHolderTime = now;
  cachedHolder = null;
  return null;
}

// ============================================================================
// PATHFINDER (cached)
// ============================================================================
async function getPathfinderResult(avatar, maxTransfers = CONFIG.PF_MAX_TRANSFERS, useTokenFilter = true) {
  const now = Date.now();
  const cached = pfCache.get(avatar);
  if (cached && now - cached.time < CONFIG.PF_CACHE_TTL_MS) return cached.result;

  const holder = await getHolder();
  if (!holder) return null;

  try {
    const pfParams = {
      source: holder.account,
      sink: avatar,
      targetFlow: ethers.parseEther(CONFIG.PF_TARGET_FLOW),
      maxTransfers,
    };
    // For personal arbs, use ToTokens filter to ensure correct token delivery
    // Without this, pathfinder routes Gnosis group CRC (useless for personal arb)
    if (useTokenFilter) {
      pfParams.toTokens = [avatar];
    }

    const pf = await Promise.race([
      findPath(pfParams),
      new Promise((_, reject) => setTimeout(() => reject(new Error("PF timeout")), 30_000)),
    ]);

    if (!pf?.transfers?.length) { pfCache.set(avatar, { result: null, time: now }); return null; }

    const maxFlow = parseFloat(pf.maxFlow) / 1e18;
    if (maxFlow < 1) { pfCache.set(avatar, { result: null, time: now }); return null; }

    const lastTransfer = pf.transfers[pf.transfers.length - 1];
    const deliveredAvatar = lastTransfer?.tokenOwner?.toLowerCase() || avatar.toLowerCase();

    const result = { pfResult: pf, maxFlow, holder: holder.account, deliveredAvatar };
    pfCache.set(avatar, { result, time: now });
    return result;
  } catch {
    pfCache.set(avatar, { result: null, time: now });
    return null;
  }
}

// ============================================================================
// OPPORTUNITY SCORING (binary search for max-profit trade size)
// ============================================================================

function spendToFlow(spend, uniRate, margin, maxFlow) {
  const demCrc = spend * uniRate;
  const erc1155 = demCrc * CONFIG.DEMURRAGE_FACTOR;
  const flowable = Math.min(erc1155 * margin, maxFlow || Infinity);
  const demErc20Sell = flowable / CONFIG.DEMURRAGE_FACTOR;
  return { flowable, demErc20Sell };
}

// Evaluate profit for a given spend. Returns { profit, flowable, sdaiOut } or null.
async function evalProfit(pool, spend, uniRate, margin) {
  const { flowable, demErc20Sell } = spendToFlow(spend, uniRate, margin, pool.maxFlow);
  if (flowable < 1) return null;
  let sdaiOut;
  if (pool.baseToken && pool.baseToken !== CONFIG.SDAI.toLowerCase()) {
    // Cross-base: CRC → GNO/WETH → WXDAI → sDAI
    const relayPool = pool.baseToken === CONFIG.GNO.toLowerCase() ? CONFIG.GNO_WXDAI_POOL : CONFIG.WETH_WXDAI_POOL;
    sdaiOut = await getCrossBaseSellQuote(pool.balPoolId, pool.erc20, pool.baseToken, relayPool, demErc20Sell);
  } else {
    sdaiOut = await getBalancerSellQuote(pool.balPoolId, pool.erc20, demErc20Sell);
  }
  if (sdaiOut === null) return null;
  if (pool.liveBaseReserve && pool.baseToken === CONFIG.SDAI.toLowerCase() && sdaiOut > pool.liveBaseReserve * 0.8) return null;
  return { profit: sdaiOut - spend, flowable, sdaiOut };
}

// Compute the max spend where flowable hits maxFlow (pathfinder limit)
function maxFlowSpend(uniRate, margin, maxFlow) {
  // flowable = spend * uniRate * DEMURRAGE_FACTOR * margin, capped at maxFlow
  // => spend = maxFlow / (uniRate * DEMURRAGE_FACTOR * margin)
  return maxFlow / (uniRate * CONFIG.DEMURRAGE_FACTOR * margin);
}

async function scoreOpportunity(pool, uniRate, sdaiBal) {
  // Live reserve check
  try {
    const [tokens, balances] = await balVault.getPoolTokens(pool.balPoolId);
    const baseToken = (pool.baseToken || CONFIG.SDAI).toLowerCase();
    const baseIdx = tokens.findIndex(t => t.toLowerCase() === baseToken);
    if (baseIdx >= 0) {
      const liveBase = parseFloat(ethers.formatEther(balances[baseIdx]));
      const minReserve = baseToken === CONFIG.GNO.toLowerCase() ? 0.005 : baseToken === CONFIG.WETH.toLowerCase() ? 0.0002 : 1.0;
      if (liveBase < minReserve) return null;
      pool.liveBaseReserve = liveBase;
    }
  } catch {}

  const margin = CONFIG.SAFETY_MARGINS[0];

  // Upper bound: min of (balance limit, pathfinder flow limit)
  const balLimit = sdaiBal * CONFIG.MAX_SPEND_FRACTION;
  const flowLimit = maxFlowSpend(uniRate, margin, pool.maxFlow || Infinity);
  const maxSpend = Math.min(balLimit, flowLimit);

  // Quick profitability check with small probe
  const probeSpend = Math.min(0.5, maxSpend);
  const smallCheck = await evalProfit(pool, probeSpend, uniRate, margin);
  if (!smallCheck || smallCheck.profit < CONFIG.MIN_PROFIT_SDAI * 0.3) return null;

  // Binary search: find the largest spend that's still profitable (profit > MIN_PROFIT).
  // This closes the spread until either prices converge or pathfinder is exhausted.
  // Then pick the spend that maximizes total profit within the profitable range.
  let lo = 0.1, hi = maxSpend;

  // Phase 1: Find the upper bound of profitability via binary search
  // (largest spend where profit > MIN_PROFIT_SDAI)
  for (let i = 0; i < 10; i++) {
    if (hi - lo < 0.1) break;
    const mid = (lo + hi) / 2;
    const r = await evalProfit(pool, mid, uniRate, margin);
    if (r && r.profit > CONFIG.MIN_PROFIT_SDAI) {
      lo = mid; // still profitable, try larger
    } else {
      hi = mid; // not profitable, try smaller
    }
  }
  const profitableMax = lo;

  // Phase 2: Find profit-maximizing spend within [small, profitableMax]
  // Profit curve is concave: rises then falls. Use ternary search.
  lo = 0.1;
  hi = profitableMax;
  for (let i = 0; i < 8; i++) {
    if (hi - lo < 0.1) break;
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const [r1, r2] = await Promise.all([
      evalProfit(pool, m1, uniRate, margin),
      evalProfit(pool, m2, uniRate, margin),
    ]);
    const p1 = r1?.profit ?? -Infinity;
    const p2 = r2?.profit ?? -Infinity;
    if (p1 < p2) lo = m1;
    else hi = m2;
  }

  const optSpend = (lo + hi) / 2;
  const result = await evalProfit(pool, optSpend, uniRate, margin);
  if (!result || result.profit < CONFIG.MIN_PROFIT_SDAI) return null;

  return {
    spend: optSpend,
    expectedProfit: result.profit,
    roi: (result.profit / optSpend) * 100,
    margin,
    flowable: result.flowable,
  };
}

// ============================================================================
// EXECUTION (personal arb - via Safe multicall, bundles arb + accumulation)
// ============================================================================
async function executeArb(opp, sizing) {
  const spendWei = ethers.parseEther(sizing.spend.toFixed(8));
  const CONTRACT_ADDR = CONFIG.CONTRACT;
  const SAFE_ADDR = CONFIG.SAFE;

  // 1. Build setup calls (configure + trust) — bundled via Safe MultiSend
  const setupCalls = [];
  const isCrossBase = opp.baseToken && opp.baseToken !== CONFIG.SDAI.toLowerCase();
  const configKey = opp.avatar + (isCrossBase ? ":cross" : "");
  if (state.lastConfiguredTarget !== configKey) {
    log("info", "exec", `Configuring for ${opp.avatar.slice(0, 10)}${isCrossBase ? " (cross-base " + (opp.baseSymbol || "GNO") + ")" : ""}...`);
    if (isCrossBase) {
      const relayPool = opp.baseToken === CONFIG.GNO.toLowerCase() ? CONFIG.GNO_WXDAI_POOL : CONFIG.WETH_WXDAI_POOL;
      setupCalls.push({ to: CONTRACT_ADDR, data: contract.interface.encodeFunctionData("configureCrossBase", [
        CONFIG.GNOSIS_GROUP_ERC20, ethers.getAddress(opp.avatar), ethers.getAddress(opp.erc20),
        opp.balPoolId, relayPool, ethers.getAddress(opp.baseToken),
      ])});
    } else {
      setupCalls.push({ to: CONTRACT_ADDR, data: contract.interface.encodeFunctionData("configure", [
        CONFIG.GNOSIS_GROUP_ERC20, ethers.getAddress(opp.avatar), ethers.getAddress(opp.erc20), opp.balPoolId,
      ])});
    }
  }

  // Trust new addresses
  const allAddrs = new Set();
  opp.pfResult.transfers.forEach(t => {
    allAddrs.add(t.from.toLowerCase());
    allAddrs.add(t.to.toLowerCase());
    allAddrs.add(t.tokenOwner.toLowerCase());
  });
  for (const addr of allAddrs) {
    if (addr === opp.holder.toLowerCase()) continue;
    if (state.trustedAddrs.has(addr)) continue;
    const checksummed = ethers.getAddress(addr);
    const trusted = await hub.isTrusted(CONTRACT_ADDR, checksummed);
    if (!trusted) {
      log("info", "exec", `Trusting ${checksummed.slice(0, 10)}...`);
      setupCalls.push({ to: CONTRACT_ADDR, data: contract.interface.encodeFunctionData("trustAvatar", [checksummed]) });
    }
    state.trustedAddrs.add(addr);
  }

  // Execute setup calls if any (separate tx — these change state needed before arb)
  if (setupCalls.length > 0) {
    if (setupCalls.length === 1) {
      await (await execSafeTx(setupCalls[0].to, setupCalls[0].data, 0, 500_000)).wait();
    } else {
      await (await execSafeMultiSend(setupCalls, 1_000_000)).wait();
    }
    state.lastConfiguredTarget = configKey;
  }

  // 2. Adapt transfers (swap holder→CONTRACT, target→CONTRACT)
  const holderAddr = opp.holder.toLowerCase();
  const targetAddr = opp.avatar.toLowerCase();
  const adapted = opp.pfResult.transfers.map(t => ({
    ...t,
    from: t.from.toLowerCase() === holderAddr ? CONTRACT_ADDR : t.from,
    to: t.to.toLowerCase() === targetAddr ? CONTRACT_ADDR : t.to,
  }));

  // 3. Build flow matrix
  const fm = buildFlowMatrix(adapted, CONTRACT_ADDR, opp.avatar, CONTRACT_ADDR);

  // 4. Scale flow edges
  const maxFlowWei = BigInt(opp.pfResult.maxFlow);
  const targetErc1155Wei = ethers.parseEther(sizing.flowable.toFixed(8));
  const scaledFlowEdges = fm.flowEdges.map(e => ({
    streamSinkId: e.streamSinkId,
    amount: e.amount * targetErc1155Wei / maxFlowWei,
  }));

  // Netting fix
  {
    const hex = (fm.packedCoordinates.startsWith("0x") ? fm.packedCoordinates.slice(2) : fm.packedCoordinates);
    const nE = scaledFlowEdges.length;
    const edgeFrom = [];
    for (let i = 0; i < nE; i++) {
      edgeFrom.push(parseInt(hex.slice(i * 12 + 4, i * 12 + 8), 16));
    }
    const srcIdx = fm.streams[0].sourceCoordinate;
    let termInflow = 0n;
    for (const eid of fm.streams[0].flowEdgeIds) {
      termInflow += scaledFlowEdges[eid].amount;
    }
    for (let i = 0; i < nE; i++) {
      if (edgeFrom[i] === srcIdx && scaledFlowEdges[i].streamSinkId === 0) {
        scaledFlowEdges[i].amount = termInflow;
        break;
      }
    }
  }

  // 5. Build the bundled MultiSend: arb + accumulation
  const execFn = isCrossBase ? "executeCrossBase" : "execute";
  const arbCallData = contract.interface.encodeFunctionData(execFn, [
    spendWei, spendWei, fm.flowVertices, scaledFlowEdges, fm.streams, fm.packedCoordinates,
  ]);

  // Build the tx bundle
  const bundle = [{ to: CONTRACT_ADDR, data: arbCallData }];

  // Convert profit to CRC and send to the avatar (only if they're a registered human)
  let profitCrc = 0;
  let giveback = false;
  const uniRate = cachedUniRate || 141;
  const erc20TransferIface = new ethers.Interface(["function transfer(address,uint256) returns (bool)"]);

  if (sizing.expectedProfit > 0) {
    const profitSdai = sizing.expectedProfit;
    profitCrc = profitSdai * uniRate;

    if (profitCrc >= 1) {
      // Check if avatar is a registered human
      const avatarLc = opp.avatar.toLowerCase();
      if (!humanCache.has(avatarLc)) {
        try {
          humanCache.set(avatarLc, await hub.isHuman(ethers.getAddress(opp.avatar)));
        } catch { humanCache.set(avatarLc, false); }
      }
      const isHuman = humanCache.get(avatarLc);

      if (isHuman) {
        giveback = true;
        const convertWei = ethers.parseEther(profitSdai.toFixed(8));
        const minCrcOut = ethers.parseEther((profitCrc * 0.95).toFixed(8)); // 5% slippage buffer
        // Swap profit sDAI → CRC
        bundle.push({
          to: CONFIG.ACCUMULATE.SWAP_ROUTER,
          data: swapRouter.interface.encodeFunctionData("exactInputSingle", [{
            tokenIn: CONFIG.SDAI,
            tokenOut: CONFIG.GNOSIS_GROUP_ERC20,
            fee: CONFIG.ACCUMULATE.UNI_FEE,
            recipient: SAFE_ADDR,
            amountIn: convertWei,
            amountOutMinimum: minCrcOut,
            sqrtPriceLimitX96: 0n,
          }]),
        });
        // Transfer the CRC to the avatar
        bundle.push({
          to: CONFIG.GNOSIS_GROUP_ERC20,
          data: erc20TransferIface.encodeFunctionData("transfer", [
            ethers.getAddress(opp.avatar), minCrcOut,
          ]),
        });
      }
    }
  }

  // Convert remaining excess sDAI above working balance to CRC (kept by Safe)
  let convertAmount = 0;
  if (CONFIG.ACCUMULATE.ENABLED) {
    const currentSdai = parseFloat(ethers.formatEther(await sdaiToken.balanceOf(SAFE_ADDR)));
    const profitSdaiUsed = giveback ? sizing.expectedProfit : 0;
    const expectedAfter = currentSdai + sizing.expectedProfit - profitSdaiUsed;
    const excess = expectedAfter - CONFIG.ACCUMULATE.SDAI_WORKING_BALANCE;
    if (excess >= CONFIG.ACCUMULATE.MIN_CONVERT_AMOUNT) {
      convertAmount = excess;
      const convertWei = ethers.parseEther(convertAmount.toFixed(8));
      bundle.push({
        to: CONFIG.ACCUMULATE.SWAP_ROUTER,
        data: swapRouter.interface.encodeFunctionData("exactInputSingle", [{
          tokenIn: CONFIG.SDAI,
          tokenOut: CONFIG.GNOSIS_GROUP_ERC20,
          fee: CONFIG.ACCUMULATE.UNI_FEE,
          recipient: SAFE_ADDR,
          amountIn: convertWei,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        }]),
      });
    }
  }

  const givebackStr = giveback ? ` +giveback ~${profitCrc.toFixed(0)} CRC→${opp.avatar.slice(0,10)}` : "";
  log("info", "exec", `TX: spend=${sizing.spend.toFixed(4)} margin=${(sizing.margin*100).toFixed(0)}% flow=${sizing.flowable.toFixed(1)} CRC ${isCrossBase ? "(cross-base)" : ""}${givebackStr}${convertAmount > 0 ? " +accumulate " + convertAmount.toFixed(1) + " sDAI→CRC" : ""}`);

  // 6. Simulate via Safe
  try {
    await simulateSafeMultiSend(bundle);
  } catch (simErr) {
    const errData = simErr.data || simErr.info?.error?.data;
    if (errData && typeof errData === "string" && errData.startsWith("0xb8c358de")) {
      try {
        const iface = new ethers.Interface(["error CirclesHubNettedFlowMismatch(uint256,int256,int256)"]);
        const d = iface.parseError(errData);
        throw new Error(`Netting mismatch: v=${d.args[0]} mat=${d.args[1]} str=${d.args[2]}`);
      } catch (de) { if (de.message.startsWith("Netting")) throw de; }
    }
    throw new Error(`Simulation reverted: ${simErr.message?.slice(0, 120)}`);
  }

  // 7. Broadcast
  log("info", "exec", "Simulation OK, broadcasting...");
  const tx = await execSafeMultiSend(bundle, 3_500_000);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("TX reverted: " + receipt.hash);

  // Update state
  if (giveback) {
    state.totalCrcGivenBack = (state.totalCrcGivenBack || 0) + profitCrc * 0.95;
  }
  if (convertAmount > 0) {
    state.totalSdaiConverted += convertAmount;
    state.totalCrcAccumulated += convertAmount * uniRate;
  }

  return { txHash: receipt.hash, gasUsed: Number(receipt.gasUsed), giveback: giveback ? Math.floor(profitCrc * 0.95) : 0 };
}

async function executeWithRetry(opp, sizing) {
  const sdaiBefore = await sdaiToken.balanceOf(CONFIG.SAFE);
  try {
    const result = await executeArb(opp, sizing);
    const sdaiAfter = await sdaiToken.balanceOf(CONFIG.SAFE);
    const actualProfit = parseFloat(ethers.formatEther(sdaiAfter - sdaiBefore));
    return { success: true, ...result, spend: sizing.spend, expectedProfit: sizing.expectedProfit, actualProfit, avatar: opp.avatar };
  } catch (e) {
    log("warn", "exec", `Failed: ${e.message?.slice(0, 150)}`);
    if (e.message?.includes("Netting mismatch")) {
      return { success: false, error: "netting", avatar: opp.avatar, spend: sizing.spend };
    }
  }

  // Retry with reduced flow
  const retries = [
    { ...sizing, margin: sizing.margin * 0.80, flowable: sizing.flowable * 0.80 },
    { ...sizing, margin: sizing.margin * 0.60, flowable: sizing.flowable * 0.60 },
  ];
  for (const retry of retries) {
    if (retry.spend < 0.05) continue;
    retry.expectedProfit = sizing.expectedProfit * (retry.flowable / sizing.flowable);
    try {
      const result = await executeArb(opp, retry);
      const sdaiAfter = await sdaiToken.balanceOf(CONFIG.SAFE);
      const actualProfit = parseFloat(ethers.formatEther(sdaiAfter - sdaiBefore));
      return { success: true, ...result, spend: retry.spend, expectedProfit: retry.expectedProfit, actualProfit, avatar: opp.avatar };
    } catch {}
  }
  return { success: false, error: "all retries failed", avatar: opp.avatar, spend: sizing.spend };
}

// ============================================================================
// APPROVAL MANAGEMENT (avoid per-trade approve tx)
// ============================================================================
const LARGE_APPROVAL = ethers.parseEther("10000"); // approve once for many trades
const MIN_ALLOWANCE = ethers.parseEther("50"); // re-approve when below this

async function ensureApproval() {
  // Safe already has permanent sDAI approval for contract + SwapRouter (set during deploy)
  try {
    const allowance = await sdaiToken.allowance(CONFIG.SAFE, CONFIG.CONTRACT);
    if (allowance < MIN_ALLOWANCE) {
      log("info", "approve", "Re-approving sDAI for contract via Safe...");
      const data = sdaiToken.interface.encodeFunctionData("approve", [CONFIG.CONTRACT, ethers.MaxUint256]);
      await (await execSafeTx(CONFIG.SDAI, data, 0, 100_000)).wait();
    }
  } catch (e) {
    log("warn", "approve", `Approval check failed: ${e.message?.slice(0, 80)}`);
  }
}

// ============================================================================
// FUND MANAGEMENT
// ============================================================================
async function ensureFunding() {
  let sdaiBal = await sdaiToken.balanceOf(CONFIG.SAFE);
  const sdaiFloat = parseFloat(ethers.formatEther(sdaiBal));
  if (sdaiFloat < 0.03) {
    const xdaiBal = await provider.getBalance(wallet.address);
    const xdaiFloat = parseFloat(ethers.formatEther(xdaiBal));
    if (xdaiFloat > 0.15) {
      const wrapAmt = ethers.parseEther(Math.max(0, xdaiFloat - 0.1).toFixed(4));
      log("info", "fund", `Wrapping ${ethers.formatEther(wrapAmt)} xDAI → sDAI`);
      const wxdai = new ethers.Contract(CONFIG.WXDAI, ["function deposit() payable", "function approve(address,uint256) returns (bool)"], wallet);
      const sdaiVault = new ethers.Contract(CONFIG.SDAI, ["function deposit(uint256,address) returns (uint256)"], wallet);
      await (await wxdai.deposit({ value: wrapAmt, gasLimit: 100000 })).wait();
      await (await wxdai.approve(CONFIG.SDAI, wrapAmt, { gasLimit: 100000 })).wait();
      await (await sdaiVault.deposit(wrapAmt, wallet.address, { gasLimit: 200000 })).wait();
      sdaiBal = await sdaiToken.balanceOf(CONFIG.SAFE);
    }
  }
  return parseFloat(ethers.formatEther(sdaiBal));
}

// ============================================================================
// GROUP ARB (generalized for any group target)
// ============================================================================
// Cache of group trust lists: groupAddr -> Set of trusted member addresses (lowercase)
const groupTrustCache = {};
const GROUP_TRUST_CACHE_TTL = 600_000; // 10 minutes

async function getGroupTrustedMembers(groupAddr) {
  const key = groupAddr.toLowerCase();
  const cached = groupTrustCache[key];
  if (cached && Date.now() - cached.time < GROUP_TRUST_CACHE_TTL) return cached.members;

  const members = new Set();
  try {
    const result = await rpcCall("circles_query", [{
      Namespace: "V_CrcV2",
      Table: "TrustRelations",
      Columns: [],
      Filter: [{ Type: "FilterPredicate", FilterType: "Equals", Column: "truster", Value: key }],
      Limit: 500,
    }]);
    const cols = result?.columns || [];
    const trusteeIdx = cols.indexOf("trustee");
    for (const row of (result?.rows || [])) {
      members.add(row[trusteeIdx]?.toLowerCase());
    }
  } catch (e) {
    log("warn", "group", `Failed to fetch trust list for ${groupAddr.slice(0,10)}: ${e.message.slice(0,80)}`);
  }
  groupTrustCache[key] = { members, time: Date.now() };
  log("info", "group", `${groupAddr.slice(0,10)} trust list: ${members.size} members`);
  return members;
}

// Cache of group treasury addresses
const groupTreasuryCache = {};

async function getGroupTreasury(groupAddr) {
  const key = groupAddr.toLowerCase();
  if (groupTreasuryCache[key]) return groupTreasuryCache[key];
  const treasury = await hub.treasuries(groupAddr);
  groupTreasuryCache[key] = treasury.toLowerCase();
  return groupTreasuryCache[key];
}

async function buildZigzagTransfers(pfTransfers, contractAddr, targetGroup, group) {
  const gnosisGroupLc = CONFIG.GNOSIS_GROUP.toLowerCase();
  const groupEdge = pfTransfers.find(t => t.tokenOwner.toLowerCase() === gnosisGroupLc);
  if (!groupEdge) return null;
  const firstIntermediary = groupEdge.to;

  // Collect all member CRCs that the pathfinder routes through the first intermediary
  const memberCrcs = {};
  for (const t of pfTransfers) {
    if (t.tokenOwner.toLowerCase() === gnosisGroupLc) continue;
    if (t.from.toLowerCase() === firstIntermediary.toLowerCase()) {
      const key = t.tokenOwner.toLowerCase();
      memberCrcs[key] = (memberCrcs[key] || 0n) + BigInt(t.value);
    }
  }

  // Filter: only keep members trusted by the group's mint handler
  // The mint handler has a wider trust set (242+) than the group itself (15)
  const mintHandler = CONFIG.GROUP_ARB.MINT_HANDLERS?.[targetGroup.toLowerCase()];
  const trustedSet = mintHandler
    ? await getGroupTrustedMembers(mintHandler)
    : await getGroupTrustedMembers(targetGroup);
  const goodMembers = {};
  let goodTotal = 0n;
  for (const [member, amount] of Object.entries(memberCrcs)) {
    if (trustedSet.has(member)) {
      goodMembers[member] = amount;
      goodTotal += amount;
    } else {
      log("info", "group", `Skipping untrusted member ${ethers.getAddress(member).slice(0,10)} (${parseFloat(ethers.formatEther(amount)).toFixed(0)} CRC)`);
    }
  }

  if (goodTotal === 0n) return null;

  const groupAddr = ethers.getAddress(targetGroup);
  // Send personal CRC to the mint handler (if available) — it has wider trust
  // The Hub routes the minting through the treasury internally
  const sendTo = mintHandler ? ethers.getAddress(mintHandler) : groupAddr;

  const actualFlow = goodTotal;
  const zigzag = [];
  zigzag.push({ tokenOwner: CONFIG.GNOSIS_GROUP, from: contractAddr, to: ethers.getAddress(firstIntermediary), value: actualFlow.toString() });
  for (const [member, amount] of Object.entries(goodMembers)) {
    zigzag.push({ tokenOwner: ethers.getAddress(member), from: ethers.getAddress(firstIntermediary), to: contractAddr, value: amount.toString() });
  }
  for (const [member, amount] of Object.entries(goodMembers)) {
    zigzag.push({ tokenOwner: ethers.getAddress(member), from: contractAddr, to: sendTo, value: amount.toString() });
  }
  zigzag.push({ tokenOwner: groupAddr, from: groupAddr, to: contractAddr, value: actualFlow.toString() });
  return { zigzag, actualFlow, members: Object.keys(goodMembers) };
}

async function checkGroupArb(group, uniRate, sdaiBal) {
  const GA = CONFIG.GROUP_ARB;
  const now = Date.now();
  if (now - (lastGroupArbTimes[group.avatar] || 0) < GA.COOLDOWN_MS) return null;

  const gnosisCost = 1 / uniRate;
  const spread = group.spotPrice / gnosisCost - 1;

  if (spread < GA.TARGET_SPREAD) return null;
  log("info", "group", `${group.avatar.slice(0,10)} spread: ${(spread * 100).toFixed(1)}% (spot=${group.spotPrice.toFixed(6)} cost=${gnosisCost.toFixed(6)})`);

  const targetNewSpot = gnosisCost * (1 + GA.TARGET_SPREAD);
  const maxAfford = sdaiBal * 0.90 / (gnosisCost * GA.SPEND_BUFFER);

  let bestSize = 0, bestProfit = -Infinity;
  for (const size of GA.TEST_SIZES) {
    if (size > maxAfford) continue;
    const rev = await getBalancerSellQuote(group.balPoolId, group.erc20, size);
    if (rev === null) continue;
    const cost = size * gnosisCost * GA.SPEND_BUFFER;
    const profit = rev - cost;
    const newSpot = (group.sdaiReserve - rev) / (group.crcReserve + size);
    if (profit > bestProfit) { bestProfit = profit; bestSize = size; }
    if (newSpot < targetNewSpot) break;
  }

  if (bestProfit < GA.MIN_PROFIT_SDAI) {
    if (spread > 0.08) log("info", "group", `${group.avatar.slice(0,10)} profit ${bestProfit.toFixed(2)} < min ${GA.MIN_PROFIT_SDAI}`);
    return null;
  }

  const infNeeded = Math.floor(bestSize * CONFIG.DEMURRAGE_FACTOR);
  const holder = await getHolder();
  if (!holder) return null;

  let pfResult;
  try {
    pfResult = await Promise.race([
      findPath({
        source: holder.account,
        sink: group.avatar,
        targetFlow: ethers.parseEther(infNeeded.toString()),
        maxTransfers: GA.PF_MAX_TRANSFERS,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("PF timeout")), 30000)),
    ]);
  } catch (e) {
    log("warn", "group", `${group.avatar.slice(0,10)} pathfinder error: ${e.message.slice(0, 80)}`);
    return null;
  }

  if (!pfResult?.transfers?.length) return null;

  // Build zigzag filtered to trusted members only
  const groupAddr = ethers.getAddress(group.avatar);
  const preZZ = await buildZigzagTransfers(pfResult.transfers, CONFIG.CONTRACT, groupAddr, group);
  if (!preZZ) {
    log("warn", "group", `${group.avatar.slice(0,10)} SKIP: no trusted members in pathfinder result`);
    return null;
  }

  const actualInf = parseFloat(ethers.formatEther(preZZ.actualFlow));
  if (actualInf < 10) return null;

  const actualDem = actualInf / CONFIG.DEMURRAGE_FACTOR;
  const actualRev = await getBalancerSellQuote(group.balPoolId, group.erc20, actualDem);
  if (!actualRev) return null;
  const actualCost = actualDem * gnosisCost * GA.SPEND_BUFFER;
  const actualProfit = actualRev - actualCost;

  if (actualProfit < GA.MIN_PROFIT_SDAI) return null;

  log("info", "group", `Opportunity: ${group.avatar.slice(0,10)} sell ${actualDem.toFixed(0)} dem CRC, profit=${actualProfit.toFixed(2)}, ${preZZ.members.length} trusted members`);
  return {
    group,
    sellDem: actualDem,
    spendSdai: actualCost,
    expectedProfit: actualProfit,
    pfResult,
    holder: holder.account,
  };
}

async function executeGroupArb(opp) {
  const { group } = opp;
  const CONTRACT_ADDR = CONFIG.CONTRACT;
  const SAFE_ADDR = CONFIG.SAFE;

  // 1. Configure + Trust via Safe
  const groupAddr = ethers.getAddress(group.avatar);
  const setupCalls = [];

  if (state.lastConfiguredTarget !== group.avatar) {
    log("info", "group-exec", `Configuring for ${group.avatar.slice(0, 10)}...`);
    setupCalls.push({ to: CONTRACT_ADDR, data: contract.interface.encodeFunctionData("configure", [
      CONFIG.GNOSIS_GROUP_ERC20, groupAddr, group.erc20, group.balPoolId,
    ])});
  }

  // 2. Build zigzag from pathfinder transfers (filtered to trusted members)
  const zzResult = await buildZigzagTransfers(opp.pfResult.transfers, CONTRACT_ADDR, groupAddr, group);
  if (!zzResult) throw new Error("Failed to build zigzag transfers (no trusted members)");
  const { zigzag, actualFlow } = zzResult;

  // Re-estimate with actual flow
  const actualDem = parseFloat(ethers.formatEther(actualFlow)) / CONFIG.DEMURRAGE_FACTOR;
  const curUniRate = cachedUniRate || 142.8;
  const revisedSpend = actualDem / curUniRate * CONFIG.GROUP_ARB.SPEND_BUFFER;
  const spendCap = parseFloat(ethers.formatEther(ethers.parseEther(opp.spendSdai.toFixed(8))));
  const spendVal = Math.min(revisedSpend, spendCap);
  const finalSpend = ethers.parseEther(spendVal.toFixed(8));
  const finalMinOut = ethers.parseEther((spendVal * 0.80).toFixed(8));

  // 3. Trust all addresses in the zigzag
  const allAddrs = new Set();
  zigzag.forEach(t => { allAddrs.add(t.from.toLowerCase()); allAddrs.add(t.to.toLowerCase()); allAddrs.add(t.tokenOwner.toLowerCase()); });
  for (const addr of allAddrs) {
    if (addr === CONTRACT_ADDR.toLowerCase()) continue;
    if (state.trustedAddrs.has(addr)) continue;
    const cs = ethers.getAddress(addr);
    const trusted = await hub.isTrusted(CONTRACT_ADDR, cs);
    if (!trusted) {
      log("info", "group-exec", `Trusting ${cs.slice(0, 10)}...`);
      setupCalls.push({ to: CONTRACT_ADDR, data: contract.interface.encodeFunctionData("trustAvatar", [cs]) });
    }
    state.trustedAddrs.add(addr);
  }

  // Execute setup calls via Safe if any
  if (setupCalls.length > 0) {
    if (setupCalls.length === 1) {
      await (await execSafeTx(setupCalls[0].to, setupCalls[0].data, 0, 500_000)).wait();
    } else {
      await (await execSafeMultiSend(setupCalls, 1_000_000)).wait();
    }
    state.lastConfiguredTarget = group.avatar;
  }

  // 4. Flow matrix
  const DUMMY = "0x0000000000000000000000000000000000000001";
  const fm = buildFlowMatrix(zigzag, CONTRACT_ADDR, DUMMY, CONTRACT_ADDR);

  // 5. Build bundle: arb + optional accumulation
  const arbCallData = contract.interface.encodeFunctionData("execute", [
    finalSpend, finalMinOut, fm.flowVertices, fm.flowEdges, fm.streams, fm.packedCoordinates,
  ]);
  const bundle = [{ to: CONTRACT_ADDR, data: arbCallData }];

  // Add accumulation if excess sDAI
  let convertAmount = 0;
  if (CONFIG.ACCUMULATE.ENABLED) {
    const currentSdai = parseFloat(ethers.formatEther(await sdaiToken.balanceOf(SAFE_ADDR)));
    const expectedAfter = currentSdai + (spendVal * 0.20); // rough profit estimate
    const excess = expectedAfter - CONFIG.ACCUMULATE.SDAI_WORKING_BALANCE;
    if (excess >= CONFIG.ACCUMULATE.MIN_CONVERT_AMOUNT) {
      convertAmount = excess;
      const convertWei = ethers.parseEther(convertAmount.toFixed(8));
      bundle.push({
        to: CONFIG.ACCUMULATE.SWAP_ROUTER,
        data: swapRouter.interface.encodeFunctionData("exactInputSingle", [{
          tokenIn: CONFIG.SDAI,
          tokenOut: CONFIG.GNOSIS_GROUP_ERC20,
          fee: CONFIG.ACCUMULATE.UNI_FEE,
          recipient: SAFE_ADDR,
          amountIn: convertWei,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        }]),
      });
    }
  }

  log("info", "group-exec", `TX: spend=${spendVal.toFixed(2)} sDAI, sell=${actualDem.toFixed(0)} CRC, ${fm.flowEdges.length} edges, ${zzResult.members.length} members${convertAmount > 0 ? " +convert " + convertAmount.toFixed(1) + " sDAI→CRC" : ""}`);

  // 6. Simulate via Safe
  try {
    await simulateSafeMultiSend(bundle);
  } catch (simErr) {
    throw new Error(`Simulation reverted: ${simErr.message?.slice(0, 300)}`);
  }

  // 7. Broadcast via Safe
  log("info", "group-exec", "Simulation OK, broadcasting...");
  const tx = await execSafeMultiSend(bundle, 5_000_000);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error("TX reverted: " + receipt.hash);

  // Update accumulation state
  if (convertAmount > 0) {
    state.totalSdaiConverted += convertAmount;
    const uniRate = cachedUniRate || 141;
    state.totalCrcAccumulated += convertAmount * uniRate;
  }

  return { txHash: receipt.hash, gasUsed: Number(receipt.gasUsed) };
}

async function runGroupArbs(uniRate, sdaiBal) {
  if (!universe?.groups?.length) return 0;

  const gnosisCost = 1 / uniRate;
  let traded = 0;

  // Sort by spread descending (most profitable first)
  const candidates = universe.groups
    .filter(g => g.spotPrice > gnosisCost * (1 + CONFIG.GROUP_ARB.TARGET_SPREAD))
    .sort((a, b) => b.spotPrice - a.spotPrice);

  for (const group of candidates) {
    // Refresh reserves
    try {
      const [tokens, balances] = await balVault.getPoolTokens(group.balPoolId);
      const sIdx = tokens.findIndex(t => t.toLowerCase() === CONFIG.SDAI.toLowerCase());
      const cIdx = tokens.findIndex(t => t.toLowerCase() === group.erc20.toLowerCase());
      if (sIdx >= 0 && cIdx >= 0) {
        group.sdaiReserve = parseFloat(ethers.formatEther(balances[sIdx]));
        group.crcReserve = parseFloat(ethers.formatEther(balances[cIdx]));
        group.spotPrice = group.sdaiReserve / group.crcReserve;
      }
    } catch { continue; }

    const opp = await checkGroupArb(group, uniRate, sdaiBal);
    if (!opp) continue;

    const sdaiBefore = await sdaiToken.balanceOf(CONFIG.SAFE);
    try {
      const result = await executeGroupArb(opp);
      const sdaiAfter = await sdaiToken.balanceOf(CONFIG.SAFE);
      const actualProfit = parseFloat(ethers.formatEther(sdaiAfter - sdaiBefore));

      state.totalTrades++;
      state.totalProfit += actualProfit;
      state.trades.push({
        time: new Date().toISOString(),
        avatar: group.avatar,
        spend: opp.spendSdai,
        expectedProfit: opp.expectedProfit,
        actualProfit,
        txHash: result.txHash,
        gasUsed: result.gasUsed,
        type: "group",
      });
      lastGroupArbTimes[group.avatar] = Date.now();
      log("trade", "group", `SUCCESS: ${group.avatar.slice(0,10)} profit=${actualProfit.toFixed(4)} sDAI | TX: ${result.txHash}`);
      saveState();
      traded++;
      idleCycles = 0;

      // Refresh balance
      sdaiBal = parseFloat(ethers.formatEther(sdaiAfter));
    } catch (e) {
      log("error", "group", `${group.avatar.slice(0,10)} FAILED: ${e.message?.slice(0, 200)}`);
      lastGroupArbTimes[group.avatar] = Date.now();
      state.totalFailed++;
      saveState();
    }
  }
  return traded;
}

// ============================================================================
// PERSONAL ARB SCANNING (direct flow, no pathfinder)
// ============================================================================
async function runPersonalArbs(uniRate, sdaiBal, cycleNum) {
  if (!universe?.personal?.length) return 0;

  const refPrice = 1 / uniRate; // sDAI per dem CRC

  // Tiered scanning: high-value pools every cycle, full scan every 5th
  const fullScan = cycleNum % 5 === 0;
  const minPrice = refPrice * 1.5; // need 50%+ margin for personal arb (after demurrage + safety margins)

  let pools = universe.personal
    .filter(p => p.spotPrice > minPrice && p.sdaiReserve > 1)
    .sort((a, b) => b.spotPrice - a.spotPrice);

  if (!fullScan) {
    pools = pools.slice(0, 50); // top 50 only on quick scans
  }

  // Filter cooldowns
  const now = Date.now();
  const active = pools.filter(p => {
    const cd = state.poolCooldowns[p.avatar];
    if (!cd) return true;
    const cooldownMs = cd.failed ? CONFIG.FAIL_COOLDOWN_MS : CONFIG.SUCCESS_COOLDOWN_MS;
    return now - cd.time > cooldownMs;
  });

  if (active.length === 0) return 0;
  log("info", "personal", `Scanning ${active.length} pools (${fullScan ? "full" : "quick"}, total ${pools.length} above ${minPrice.toFixed(4)})`);

  // Pathfind + score in batches (circlesubi with toTokens filter)
  const scored = [];
  const batchSize = 10;
  for (let i = 0; i < active.length; i += batchSize) {
    const batch = active.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async pool => {
        // Get pathfinder result (uses circlesubi with toTokens for correct token delivery)
        const pfData = await getPathfinderResult(pool.avatar);
        if (!pfData) return null;

        // Verify delivered token matches target (or find alternative pool)
        let sellPool = pool;
        if (pfData.deliveredAvatar && pfData.deliveredAvatar !== pool.avatar) {
          const alt = universe.personal.find(p => p.avatar === pfData.deliveredAvatar);
          if (!alt) return null;
          sellPool = alt;
        }

        const opp = {
          avatar: sellPool.avatar,
          erc20: sellPool.erc20,
          balPoolId: sellPool.balPoolId,
          baseToken: sellPool.baseToken,
          baseSymbol: sellPool.baseSymbol,
          maxFlow: pfData.maxFlow,
          pfResult: pfData.pfResult,
          holder: pfData.holder,
        };

        const sizing = await scoreOpportunity(opp, uniRate, sdaiBal);
        if (!sizing) return null;
        return { opp, sizing };
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) scored.push(r.value);
    }
    if (scored.length >= 3 && scored.some(s => s.sizing.expectedProfit > 0.1)) break;
    if ((i + batchSize) % 50 === 0) {
      log("info", "personal", `Checked ${Math.min(i + batchSize, active.length)}/${active.length}, found ${scored.length}`);
    }
  }

  if (scored.length === 0) return 0;

  scored.sort((a, b) => b.sizing.expectedProfit - a.sizing.expectedProfit);
  for (const s of scored.slice(0, 5)) {
    log("info", "scoring", `${s.opp.avatar.slice(0,10)} profit=${s.sizing.expectedProfit.toFixed(4)} spend=${s.sizing.spend.toFixed(2)} flow=${s.sizing.flowable.toFixed(0)}/${(s.opp.maxFlow||0).toFixed(0)} ROI=${s.sizing.roi.toFixed(0)}%`);
  }

  let traded = 0;
  for (const entry of scored.slice(0, 3)) {
    const curBal = parseFloat(ethers.formatEther(await sdaiToken.balanceOf(CONFIG.SAFE)));
    if (curBal < CONFIG.BALANCE_FLOOR) break;
    if (curBal < entry.sizing.spend * 1.05) {
      if (curBal < 0.05) break;
      const ratio = (curBal * 0.9) / entry.sizing.spend;
      entry.sizing.spend *= ratio;
      entry.sizing.flowable *= ratio;
      entry.sizing.expectedProfit *= ratio;
    }

    const result = await executeWithRetry(entry.opp, entry.sizing);
    if (result.success) {
      state.totalTrades++;
      state.totalProfit += result.actualProfit;
      state.trades.push({
        time: new Date().toISOString(),
        avatar: result.avatar,
        spend: result.spend,
        expectedProfit: result.expectedProfit,
        actualProfit: result.actualProfit,
        txHash: result.txHash,
        gasUsed: result.gasUsed,
        type: "personal",
        givebackCrc: result.giveback || 0,
      });
      log("trade", "personal", `SUCCESS: profit=${result.actualProfit.toFixed(4)} sDAI${result.giveback ? " (+" + result.giveback + " CRC given back)" : ""} | Total: ${state.totalTrades} trades, ${state.totalProfit.toFixed(4)} sDAI | TX: ${result.txHash}`);
      state.poolCooldowns[entry.opp.avatar] = { time: Date.now(), failed: false };
      traded++;
      idleCycles = 0;
    } else {
      state.totalFailed++;
      state.poolCooldowns[result.avatar] = { time: Date.now(), failed: true };
    }
  }

  saveState();
  return traded;
}

// ============================================================================
// TOKEN UNIVERSE REFRESH
// ============================================================================
async function refreshUniverse() {
  const now = Date.now();
  if (universe && now - universeRefreshTime < CONFIG.UNIVERSE_REFRESH_MS) return;

  try {
    universe = await discover(provider, (msg) => log("info", "universe", msg));
    universeRefreshTime = now;
  } catch (e) {
    log("error", "universe", `Discovery failed: ${e.message?.slice(0, 150)}`);
    if (!universe) throw e; // fatal on first run
  }
}

// ============================================================================
// SAFETY CHECKS
// ============================================================================
function checkSafety() {
  // Check hourly P&L
  const now = Date.now();
  const hourAgo = now - 3_600_000;
  const recentTrades = state.trades.filter(t => new Date(t.time).getTime() > hourAgo);
  const hourlyPnl = recentTrades.reduce((sum, t) => sum + (t.actualProfit || 0), 0);

  if (hourlyPnl < -CONFIG.MAX_HOURLY_LOSS) {
    log("error", "safety", `Hourly loss ${hourlyPnl.toFixed(2)} exceeds limit ${CONFIG.MAX_HOURLY_LOSS}. Pausing 30min.`);
    return false;
  }
  return true;
}

// ============================================================================
// PROFIT ACCUMULATION: convert excess sDAI → Gnosis CRC
// ============================================================================
async function convertExcessToCrc() {
  if (!CONFIG.ACCUMULATE.ENABLED) return;

  const sdaiBal = parseFloat(ethers.formatEther(await sdaiToken.balanceOf(CONFIG.SAFE)));
  const excess = sdaiBal - CONFIG.ACCUMULATE.SDAI_WORKING_BALANCE;
  if (excess < CONFIG.ACCUMULATE.MIN_CONVERT_AMOUNT) return;

  const convertAmount = excess;
  const convertWei = ethers.parseEther(convertAmount.toFixed(8));

  try {
    const SAFE_ADDR = CONFIG.SAFE;
    const crcBefore = await gnosisCrcToken.balanceOf(SAFE_ADDR);

    // Swap sDAI → Gnosis CRC via Safe → SwapRouter02
    const swapData = swapRouter.interface.encodeFunctionData("exactInputSingle", [{
      tokenIn: CONFIG.SDAI,
      tokenOut: CONFIG.GNOSIS_GROUP_ERC20,
      fee: CONFIG.ACCUMULATE.UNI_FEE,
      recipient: SAFE_ADDR,
      amountIn: convertWei,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    }]);
    const tx = await execSafeTx(CONFIG.ACCUMULATE.SWAP_ROUTER, swapData, 0, 300_000);
    const receipt = await tx.wait();

    const crcAfter = await gnosisCrcToken.balanceOf(SAFE_ADDR);
    const crcReceived = parseFloat(ethers.formatEther(crcAfter - crcBefore));

    state.totalSdaiConverted += convertAmount;
    state.totalCrcAccumulated += crcReceived;
    saveState();

    const crcTotal = parseFloat(ethers.formatEther(crcAfter));
    log("trade", "accumulate", `Converted ${convertAmount.toFixed(2)} sDAI → ${crcReceived.toFixed(1)} CRC | Total CRC: ${crcTotal.toFixed(1)} | TX: ${receipt.hash}`);
  } catch (e) {
    log("warn", "accumulate", `Conversion failed: ${e.message?.slice(0, 120)}`);
  }
}

// ============================================================================
// MAIN CYCLE
// ============================================================================
async function runCycle(cycleNum) {
  log("info", "cycle", `=== Cycle ${cycleNum} ===`);

  if (!checkSafety()) {
    await new Promise(r => setTimeout(r, 1_800_000)); // 30 min pause
    return;
  }

  await refreshUniverse();
  await ensureApproval();

  const sdaiBal = await ensureFunding();
  log("info", "cycle", `sDAI: ${sdaiBal.toFixed(4)}`);
  if (sdaiBal < CONFIG.BALANCE_FLOOR) { log("warn", "cycle", "Below balance floor"); return; }

  const uniRate = await getUniV3Rate();
  const refPrice = 1 / uniRate;
  log("info", "cycle", `UniV3: 1 sDAI → ${uniRate.toFixed(1)} dem CRC (ref ${refPrice.toFixed(6)} sDAI/CRC)`);

  // 1. Group arbs (highest priority)
  let groupTrades = 0;
  try {
    groupTrades = await runGroupArbs(uniRate, sdaiBal);
  } catch (e) {
    log("error", "cycle", `Group arb error: ${e.message?.slice(0, 150)}`);
  }

  // 2. Personal arbs
  let personalTrades = 0;
  try {
    const curBal = groupTrades > 0
      ? parseFloat(ethers.formatEther(await sdaiToken.balanceOf(CONFIG.SAFE)))
      : sdaiBal;
    personalTrades = await runPersonalArbs(uniRate, curBal, cycleNum);
  } catch (e) {
    log("error", "cycle", `Personal arb error: ${e.message?.slice(0, 150)}`);
  }

  if (groupTrades + personalTrades === 0) {
    idleCycles++;
  }

  // Convert excess sDAI to Gnosis CRC
  try {
    await convertExcessToCrc();
  } catch (e) {
    log("warn", "cycle", `Accumulation error: ${e.message?.slice(0, 100)}`);
  }

  writeHeartbeat();
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  rotateLog();

  console.log("=============================================================");
  console.log("  Circles CRC Arbitrage Bot v2");
  console.log("  EOA: " + wallet.address);
  console.log("  Contract: " + CONFIG.CONTRACT);
  console.log("=============================================================\n");

  loadState();

  let cycleNum = 0;
  const startTime = Date.now();

  while (true) {
    cycleNum++;
    try {
      await runCycle(cycleNum);
    } catch (e) {
      log("error", "main", `Cycle ${cycleNum} crashed: ${e.message?.slice(0, 300)}`);
      state.totalFailed++;
    }

    // Status every 5 cycles
    if (cycleNum % 5 === 0) {
      const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
      const uniStr = universe ? `${universe.personal.length}p/${universe.groups.length}g` : "?";
      log("info", "status", `${elapsed}min | ${state.totalTrades} trades | ${state.totalProfit.toFixed(4)} sDAI | ${(state.totalCrcGivenBack||0).toFixed(0)} CRC given back | idle=${idleCycles} | universe=${uniStr}`);
    }

    // Adaptive interval: faster when active, slower when idle
    const interval = idleCycles > CONFIG.IDLE_THRESHOLD ? CONFIG.SLOW_INTERVAL_MS : CONFIG.LOOP_INTERVAL_MS;
    await new Promise(r => setTimeout(r, interval));
  }
}

process.on("SIGINT", () => { saveState(); process.exit(0); });
process.on("SIGTERM", () => { saveState(); process.exit(0); });

main().catch(e => { log("error", "main", "Fatal: " + e.message); saveState(); process.exit(1); });
