const { ethers } = require("ethers");

/**
 * Build a flow matrix from pathfinder transfers, redirecting the final
 * destination to `recipient` instead of the original sink.
 *
 * @param {Array} transfers - from pathfinder result
 * @param {string} source - our contract address (stream source)
 * @param {string} originalSink - the pathfinder's sink address
 * @param {string} recipient - where tokens should actually end up (usually = source)
 * @param {BigInt} [scaleNum] - numerator for scaling (optional)
 * @param {BigInt} [scaleDenom] - denominator for scaling (optional)
 * @returns {{ flowVertices, flowEdges, streams, packedCoordinates }}
 */
function buildFlowMatrix(transfers, source, originalSink, recipient, scaleNum, scaleDenom) {
  const src = source.toLowerCase();
  const sink = originalSink.toLowerCase();
  const rcpt = recipient.toLowerCase();

  // Redirect: any transfer going to the sink goes to recipient instead
  const modTransfers = transfers.map(t => ({
    tokenOwner: t.tokenOwner.toLowerCase(),
    from: t.from.toLowerCase(),
    to: t.to.toLowerCase() === sink ? rcpt : t.to.toLowerCase(),
    value: BigInt(t.value),
  }));

  // Collect unique addresses, sorted numerically
  const addrs = new Set();
  modTransfers.forEach(t => { addrs.add(t.tokenOwner); addrs.add(t.from); addrs.add(t.to); });
  const flowVertices = [...addrs].sort((a, b) => {
    const l = BigInt(a), r = BigInt(b);
    return l < r ? -1 : l > r ? 1 : 0;
  });
  const idx = {};
  flowVertices.forEach((a, i) => { idx[a] = i; });

  // Flow edges: mark edges arriving at recipient (from non-recipient) as terminal
  const flowEdges = modTransfers.map(t => {
    const isTerminal = (t.to === rcpt && t.from !== rcpt) ? 1 : 0;
    let amount = t.value;
    if (scaleNum !== undefined && scaleDenom !== undefined) {
      amount = amount * scaleNum / scaleDenom;
    }
    return { streamSinkId: isTerminal, amount };
  });

  // Ensure at least one terminal edge
  if (!flowEdges.some(e => e.streamSinkId === 1)) {
    flowEdges[flowEdges.length - 1].streamSinkId = 1;
  }

  const termEdgeIds = flowEdges.map((e, i) => e.streamSinkId === 1 ? i : -1).filter(i => i !== -1);
  const streams = [{ sourceCoordinate: idx[src], flowEdgeIds: termEdgeIds, data: "0x" }];

  // Packed coordinates: 3 uint16s per transfer (tokenOwner, from, to)
  const coords = [];
  modTransfers.forEach(t => {
    coords.push(idx[t.tokenOwner]);
    coords.push(idx[t.from]);
    coords.push(idx[t.to]);
  });

  return {
    flowVertices: flowVertices.map(v => ethers.getAddress(v)),
    flowEdges,
    streams,
    packedCoordinates: packCoordinates(coords),
  };
}

function packCoordinates(coords) {
  const bytes = new Uint8Array(coords.length * 2);
  coords.forEach((c, i) => {
    bytes[2 * i] = c >> 8;
    bytes[2 * i + 1] = c & 0xff;
  });
  return ethers.hexlify(bytes);
}

/**
 * Encode ArbParams for the FlashArbV7 contract.
 */
function encodeArbParams({
  groupCrcErc20, groupAvatar, sellPoolId, expCrcErc20, expAvatar,
  flowVertices, flowEdges, streams, packedCoordinates,
}) {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(
    ["address", "address", "bytes32", "address", "address",
     "address[]", "tuple(uint16,uint192)[]", "tuple(uint16,uint16[],bytes)[]", "bytes"],
    [
      groupCrcErc20, groupAvatar,
      sellPoolId, expCrcErc20, expAvatar,
      flowVertices,
      flowEdges.map(e => [e.streamSinkId, e.amount]),
      streams.map(s => [s.sourceCoordinate, s.flowEdgeIds, s.data]),
      packedCoordinates,
    ]
  );
}

module.exports = { buildFlowMatrix, packCoordinates, encodeArbParams };
