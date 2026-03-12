# The Friendly Circles Arb Bot

An arbitrage bot for [Circles UBI](https://www.aboutcircles.com/) that balances CRC token prices across DEXes and **gives profits back to the people** whose tokens were arbitraged.

## How it works

1. **Buy** cheap group CRC (Gnosis group) on UniswapV3 using sDAI
2. **Unwrap** group CRC (ERC20 → ERC1155)
3. **Route** through the Circles trust graph via `operateFlowMatrix` to get personal CRC
4. **Wrap** personal CRC (ERC1155 → ERC20)
5. **Sell** on Balancer for sDAI
6. **Convert** the profit to Gnosis group CRC and **send it to the person** whose pool was arbed

All steps happen atomically in a single transaction via a Gnosis Safe MultiSend.

## Architecture

```
EOA → Gnosis Safe (MultiSend) → AtomicPersonalArb contract → UniV3 / Balancer / Hub
                               → SwapRouter (profit → CRC)
                               → CRC transfer to avatar
```

## Key addresses (Gnosis Chain)

- **Safe**: `0x3F4cCACf2173553850258dE2E8495366a0F10c31`
- **Contract**: `0x79F281B346204B7af83D9ec5C2251376e170e43f`
- **Hub v2**: `0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8`
- **UniV3 Pool** (sDAI/GnosisCRC): `0x582F85E3fDd6EfE0CcF71D1fa6b1B87d8e64CE7d`
- **Balancer Vault**: `0xBA12222222228d8Ba445958a75a0704d566BF2C8`

## Files

```
contracts/
  AtomicPersonalArb.sol   - On-chain arb contract (owner = Safe)
  AtomicPersonalArb.json  - Compiled artifact (ABI + bytecode)
lib/
  circles-rpc.js          - Pathfinder queries (aboutcircles + circlesubi RPCs)
  flow-matrix.js          - Flow matrix construction for operateFlowMatrix
  token-universe.js       - On-chain token/pool discovery
scripts/
  bot.js                  - Main autonomous bot loop
  dashboard.js            - Web dashboard (port 3000)
  deploy-safe.js          - Deploy Safe + contract + setup
  distribute-crc.js       - Batch distribute CRC to avatars
```

## Setup

```bash
npm install ethers
export PRIVATE_KEY=<your-eoa-private-key>

# 1. Deploy Safe + contract
node scripts/deploy-safe.js

# 2. Update CONFIG in bot.js with deployed addresses

# 3. Run the bot
node scripts/bot.js

# 4. Dashboard (optional)
node scripts/dashboard.js
```

## Dashboard

The dashboard shows a giveback leaderboard — who received how much CRC — with links to [Circles Explorer](https://explorer.aboutcircles.com) profiles.

## The "friendly" part

When the bot arbs someone's personal CRC pool, it converts the sDAI profit into Gnosis group CRC and sends it directly to that person's address — but only if they're a registered Circles human (verified via `Hub.isHuman()`). This happens atomically in the same transaction as the arb itself.
