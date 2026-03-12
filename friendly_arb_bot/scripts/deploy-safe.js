#!/usr/bin/env node
/**
 * Deploy Gnosis Safe + new AtomicPersonalArb owned by the Safe.
 *
 * Architecture:
 *   EOA → Safe (multicall) → AtomicPersonalArb → UniV3/Balancer/Hub
 *                           → SwapRouter02 (profit accumulation)
 *
 * Steps:
 *   1. Deploy Safe via SafeProxyFactory (EOA as sole owner, threshold=1)
 *   2. Deploy new AtomicPersonalArb(uniPool, safeAddress)
 *   3. Via Safe multicall: setup() + approve sDAI for contract + approve sDAI for SwapRouter
 *   4. Transfer sDAI + CRC from EOA to Safe
 *   5. Copy trusted addresses from old contract
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const provider = new ethers.JsonRpcProvider("https://rpc.gnosischain.com");
const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error("Set PRIVATE_KEY env var"); process.exit(1); }
const wallet = new ethers.Wallet(PK, provider);

// Addresses
const UNI_POOL = "0x582F85E3fDd6EfE0CcF71D1fa6b1B87d8e64CE7d";
const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";
const GNOSIS_CRC = "0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A";
const SWAP_ROUTER = "0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be";

// Safe contracts (v1.3.0, same across chains)
const SAFE_SINGLETON = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552";
const SAFE_PROXY_FACTORY = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2";
const MULTI_SEND = "0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761";
const FALLBACK_HANDLER = "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4";

// Safe ABIs
const safeAbi = [
  "function setup(address[] calldata _owners, uint256 _threshold, address to, bytes calldata data, address fallbackHandler, address paymentToken, uint256 payment, address payable paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) public view returns (bytes32)",
  "function nonce() public view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

const factoryAbi = [
  "function createProxyWithNonce(address _singleton, bytes memory initializer, uint256 saltNonce) public returns (address proxy)",
  "event ProxyCreation(address proxy, address singleton)",
];

const multiSendAbi = [
  "function multiSend(bytes memory transactions) public payable",
];

// Helper: encode a transaction for MultiSend
function encodeMultiSendTx(operation, to, value, data) {
  const dataBytes = ethers.getBytes(data);
  return ethers.solidityPacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [operation, to, value, dataBytes.length, dataBytes]
  );
}

// Helper: execute a Safe transaction (EOA is sole owner, threshold=1)
async function execSafeTx(safe, to, value, data, operation = 0) {
  const nonce = await safe.nonce();
  const txHash = await safe.getTransactionHash(
    to, value, data, operation,
    0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce
  );
  // Sign with EOA (sole owner). For threshold=1, we use a standard ECDSA signature
  const sig = wallet.signingKey.sign(txHash);
  const signature = ethers.solidityPacked(
    ["bytes32", "bytes32", "uint8"],
    [sig.r, sig.s, sig.v]
  );
  const tx = await safe.execTransaction(
    to, value, data, operation,
    0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signature,
    { gasLimit: 2_000_000 }
  );
  const receipt = await tx.wait();
  console.log(`  Safe TX: ${receipt.hash} (gas: ${receipt.gasUsed})`);
  return receipt;
}

// Helper: execute MultiSend via Safe
async function execMultiSend(safe, txs) {
  const encoded = ethers.concat(txs.map(t => encodeMultiSendTx(t.op || 0, t.to, t.value || 0n, t.data)));
  const multiSendIface = new ethers.Interface(multiSendAbi);
  const data = multiSendIface.encodeFunctionData("multiSend", [encoded]);
  return execSafeTx(safe, MULTI_SEND, 0n, data, 1); // operation=1 = delegatecall
}

async function main() {
  console.log("EOA:", wallet.address);
  console.log("");

  // ========================================================================
  // 1. Deploy Gnosis Safe
  // ========================================================================
  console.log("1. Deploying Gnosis Safe...");
  const factory = new ethers.Contract(SAFE_PROXY_FACTORY, factoryAbi, wallet);
  const safeIface = new ethers.Interface(safeAbi);

  const setupData = safeIface.encodeFunctionData("setup", [
    [wallet.address],     // owners
    1,                    // threshold
    ethers.ZeroAddress,   // to (no delegate call on setup)
    "0x",                 // data
    FALLBACK_HANDLER,     // fallback handler
    ethers.ZeroAddress,   // payment token
    0,                    // payment
    ethers.ZeroAddress,   // payment receiver
  ]);

  const saltNonce = Date.now();
  const tx = await factory.createProxyWithNonce(SAFE_SINGLETON, setupData, saltNonce, { gasLimit: 500_000 });
  const receipt = await tx.wait();
  const proxyEvent = receipt.logs.find(l => {
    try { return factory.interface.parseLog(l)?.name === "ProxyCreation"; } catch { return false; }
  });
  const safeAddress = proxyEvent ? factory.interface.parseLog(proxyEvent).args.proxy : null;
  if (!safeAddress) throw new Error("Failed to get Safe address from logs");

  console.log(`  Safe deployed: ${safeAddress}`);
  console.log(`  TX: ${receipt.hash}`);

  const safe = new ethers.Contract(safeAddress, safeAbi, wallet);

  // Verify
  const owners = await safe.getOwners();
  const threshold = await safe.getThreshold();
  console.log(`  Owners: ${owners}, Threshold: ${threshold}`);

  // ========================================================================
  // 2. Deploy new AtomicPersonalArb(uniPool, safeAddress)
  // ========================================================================
  console.log("\n2. Deploying AtomicPersonalArb...");
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "contracts", "AtomicPersonalArb.json")));
  const arbFactory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const arbContract = await arbFactory.deploy(UNI_POOL, safeAddress, { gasLimit: 5_000_000 });
  await arbContract.waitForDeployment();
  const arbAddress = await arbContract.getAddress();
  console.log(`  Contract deployed: ${arbAddress}`);
  console.log(`  Owner: ${await arbContract.owner()}`);

  // ========================================================================
  // 3. Via Safe multicall: setup() + approve sDAI
  // ========================================================================
  console.log("\n3. Setting up via Safe multicall...");
  const arbIface = new ethers.Interface(artifact.abi);
  const erc20Iface = new ethers.Interface([
    "function approve(address,uint256) returns (bool)",
  ]);

  await execMultiSend(safe, [
    // a. Contract setup (registerOrganization + setApprovalForAll)
    { to: arbAddress, data: arbIface.encodeFunctionData("setup") },
    // b. Approve sDAI for the arb contract (to pull sDAI via transferFrom)
    { to: SDAI, data: erc20Iface.encodeFunctionData("approve", [arbAddress, ethers.MaxUint256]) },
    // c. Approve sDAI for SwapRouter02 (for profit accumulation)
    { to: SDAI, data: erc20Iface.encodeFunctionData("approve", [SWAP_ROUTER, ethers.MaxUint256]) },
  ]);
  console.log("  Setup + approvals done");

  // ========================================================================
  // 4. Transfer sDAI + CRC from EOA to Safe
  // ========================================================================
  console.log("\n4. Transferring funds to Safe...");
  const sdai = new ethers.Contract(SDAI, [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
  ], wallet);
  const crc = new ethers.Contract(GNOSIS_CRC, [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
  ], wallet);

  const sdaiBal = await sdai.balanceOf(wallet.address);
  const crcBal = await crc.balanceOf(wallet.address);
  console.log(`  EOA sDAI: ${ethers.formatEther(sdaiBal)}`);
  console.log(`  EOA CRC:  ${ethers.formatEther(crcBal)}`);

  if (sdaiBal > 0n) {
    const tx1 = await sdai.transfer(safeAddress, sdaiBal, { gasLimit: 100_000 });
    await tx1.wait();
    console.log(`  Transferred ${ethers.formatEther(sdaiBal)} sDAI to Safe`);
  }
  if (crcBal > 0n) {
    const tx2 = await crc.transfer(safeAddress, crcBal, { gasLimit: 100_000 });
    await tx2.wait();
    console.log(`  Transferred ${ethers.formatEther(crcBal)} CRC to Safe`);
  }

  // ========================================================================
  // 5. Copy trusted addresses from bot state
  // ========================================================================
  console.log("\n5. Copying trust list...");
  const stateFile = path.join(__dirname, "..", "data", "bot-state.json");
  let trustedAddrs = [];
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    trustedAddrs = state.trustedAddrs || [];
  } catch {}
  console.log(`  ${trustedAddrs.length} addresses to trust`);

  // Batch trust via MultiSend (max 20 per batch to stay within gas limits)
  for (let i = 0; i < trustedAddrs.length; i += 20) {
    const batch = trustedAddrs.slice(i, i + 20);
    await execMultiSend(safe, batch.map(addr => ({
      to: arbAddress,
      data: arbIface.encodeFunctionData("trustAvatar", [ethers.getAddress(addr)]),
    })));
    console.log(`  Trusted ${Math.min(i + 20, trustedAddrs.length)}/${trustedAddrs.length}`);
  }

  // ========================================================================
  // Summary
  // ========================================================================
  console.log("\n========================================");
  console.log("DEPLOYMENT COMPLETE");
  console.log("========================================");
  console.log(`Safe:     ${safeAddress}`);
  console.log(`Contract: ${arbAddress}`);
  console.log(`EOA:      ${wallet.address}`);
  console.log("");
  console.log("Update bot.js CONFIG with:");
  console.log(`  SAFE: "${safeAddress}",`);
  console.log(`  CONTRACT: "${arbAddress}",`);
  console.log("");

  // Verify Safe balances
  const safeSdai = await sdai.balanceOf(safeAddress);
  const safeCrc = await crc.balanceOf(safeAddress);
  console.log(`Safe sDAI: ${ethers.formatEther(safeSdai)}`);
  console.log(`Safe CRC:  ${ethers.formatEther(safeCrc)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
