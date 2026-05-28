# Circles Dollar Auction

A dollar-auction variant played entirely in a single **Circles group currency**. One
contract registers itself as a Circles **organization** and trusts exactly one group
avatar (the Gnosis group), so it only ever accepts that group's Circles.

**Live page:** https://koeppelmann.github.io/CirclesTools/dollarAuction/

## Rules

- The **owner** seeds a fixed prize pool (e.g. 10 000 CRC).
- Each **bid** is a fixed amount (e.g. 100 CRC), placed by sending the accepted group
  token to the contract.
  - Not the accepted token, or below the bid → rejected (funds stay with the sender).
  - Above the bid → accepted as one bid, excess returned.
- A bid splits **10 % → pool**, **10 % → owner**, **80 % → a FIFO claim queue**. Every
  bid also appends a **110 %** claim for the bidder at the back of that queue.
- The **last bidder wins the whole pool** if no one bids before the timer expires.
- The timer starts long (e.g. 24h) and **decays geometrically per bid** (half-life ≈ 13
  bids) down to a short floor (e.g. 5 min) — the crowd shrinks the clock.

Each round mints 110 of claims but funds only 80, so the front ~72.7 % of bidders are
always made whole (+10 %); the tail is unpaid until more bids arrive — except the very
last bidder, who takes the pool.

## Payments go through `operateFlowMatrix`

Bids/seed arrive as Circles **path payments** (the Gnosis app's transfer). The contract's
`onERC1155Received` / `onERC1155BatchReceived` handle both single and multi-edge terminal
deliveries — summing the chunks of the accepted token, with `from` = the original payer
(the stream source). This mirrors the proven `LotteryFactory` receiver pattern.

## Contract

`src/CirclesDollarAuction.sol` (interface `src/IHubV2.sol`). Key entrypoints:
`onERC1155Received` / `onERC1155BatchReceived` (seed/bid/refund), `claimPrize()`,
`reclaimSeed()`, `transferOwnership()`, `recoverFailedCredit()`, and the `gameInfo()` view.

Claim payouts and the owner cut are pushed out immediately, so the contract only holds the
prize pool (which demurrages like all Circles). A recipient that refuses a push can't stall
the game — the amount is parked in `failedCredits` and recovered later.

## Test deployment (Gnosis Chain)

- Contract: `0xcb5d876EfBd47B116Bd5724d37C3479214Fa7179`
- Accepted group: `0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c`
- Hub: `0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8`
- Params: bid 1 CRC, starting price 100 CRC, timer 5 min → 1 min floor.

Set `CONFIG.CONTRACT` in `index.html` to point the UI at a deployment.

## Build & test (Foundry)

```bash
forge install foundry-rs/forge-std   # provides lib/forge-std
forge test -vv
```

Covers registration, seeding, token/amount rejection + refunds, the 10/10/80 split, FIFO
claim accounting, geometric timer decay (200 bids), path-payment batch delivery, a
120-bid large run (per-bidder repayment + conservation), the winner payout, ownership
transfer, scaled bid sizes, and a hostile-recipient stall test.

## Deploy

```bash
export PRIVATE_KEY=0x... GROUP=0x... OWNER=0x...
# optional overrides: NAME, STARTING_PRICE, BID, INITIAL_TIMER, MIN_TIMER, RATIO_NUM, RATIO_DEN
forge script script/Deploy.s.sol --rpc-url https://rpc.gnosischain.com --broadcast
```
