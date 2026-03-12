#!/usr/bin/env node
/**
 * Distribute Gnosis CRC to backers proportional to arb profit extracted.
 * Sends from Safe via MultiSend in batches of 20.
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const provider = new ethers.JsonRpcProvider("https://rpc.gnosischain.com");
const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error("Set PRIVATE_KEY env var"); process.exit(1); }
const wallet = new ethers.Wallet(PK, provider);

const SAFE_ADDR = "0x3F4cCACf2173553850258dE2E8495366a0F10c31";
const GNOSIS_CRC = "0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A";
const MULTI_SEND = "0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761";

const safeAbi = [
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) public view returns (bytes32)",
  "function nonce() public view returns (uint256)",
];
const multiSendAbi = ["function multiSend(bytes memory transactions) public payable"];
const erc20Iface = new ethers.Interface(["function transfer(address,uint256) returns (bool)"]);

const safe = new ethers.Contract(SAFE_ADDR, safeAbi, wallet);
const multiSendIface = new ethers.Interface(multiSendAbi);

function encodeMultiSendTx(to, data, operation = 0, value = 0n) {
  const dataBytes = ethers.getBytes(data);
  return ethers.solidityPacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [operation, to, value, dataBytes.length, dataBytes]
  );
}

async function execSafeTx(to, value, data, operation = 0, gasLimit = 2_000_000) {
  const nonce = await safe.nonce();
  const txHash = await safe.getTransactionHash(to, value, data, operation, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce);
  const sig = wallet.signingKey.sign(txHash);
  const signature = ethers.solidityPacked(["bytes32", "bytes32", "uint8"], [sig.r, sig.s, sig.v]);
  const tx = await safe.execTransaction(to, value, data, operation, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signature, { gasLimit });
  return tx.wait();
}

async function execMultiSend(txs, gasLimit = 3_000_000) {
  const encoded = ethers.concat(txs.map(t => encodeMultiSendTx(t.to, t.data)));
  const data = multiSendIface.encodeFunctionData("multiSend", [encoded]);
  return execSafeTx(MULTI_SEND, 0n, data, 1, gasLimit);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const dist = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "distribution.json")));

  // Verify balance
  const crc = new ethers.Contract(GNOSIS_CRC, ["function balanceOf(address) view returns (uint256)"], provider);
  const bal = await crc.balanceOf(SAFE_ADDR);
  const totalToSend = dist.reduce((s, d) => s + d.crc, 0);
  console.log(`Safe CRC balance: ${ethers.formatEther(bal)}`);
  console.log(`Total to distribute: ${totalToSend.toFixed(2)} CRC to ${dist.length} avatars`);

  if (parseFloat(ethers.formatEther(bal)) < totalToSend) {
    console.error("Insufficient balance!");
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n--- DRY RUN ---");
    for (const d of dist) {
      console.log(`  ${d.avatar}  ${d.crc.toFixed(4)} CRC  (${d.trades} trades, ${d.profit.toFixed(4)} sDAI profit)`);
    }
    console.log(`\nTotal: ${totalToSend.toFixed(4)} CRC in ${Math.ceil(dist.length / 20)} batches`);
    return;
  }

  // Execute in batches of 20
  const BATCH_SIZE = 20;
  let sent = 0;
  for (let i = 0; i < dist.length; i += BATCH_SIZE) {
    const batch = dist.slice(i, i + BATCH_SIZE);
    const txs = batch.map(d => ({
      to: GNOSIS_CRC,
      data: erc20Iface.encodeFunctionData("transfer", [
        ethers.getAddress(d.avatar),
        ethers.parseEther(d.crc.toFixed(6)),
      ]),
    }));

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(dist.length / BATCH_SIZE);
    console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} transfers)...`);

    try {
      const receipt = await execMultiSend(txs);
      sent += batch.length;
      console.log(`  TX: ${receipt.hash} (gas: ${receipt.gasUsed})`);
      console.log(`  Sent ${sent}/${dist.length}`);
    } catch (e) {
      console.error(`  FAILED: ${e.message.slice(0, 200)}`);
      console.error(`  Stopping at batch ${batchNum}. ${sent} transfers completed.`);
      process.exit(1);
    }
  }

  const finalBal = await crc.balanceOf(SAFE_ADDR);
  console.log(`\nDone! ${sent} transfers completed.`);
  console.log(`Remaining Safe CRC: ${ethers.formatEther(finalBal)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
