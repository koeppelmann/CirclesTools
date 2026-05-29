# Circles Dollar Auction — Mini-App

A dollar-auction game played entirely in Gnosis-group Circles. Be the **last bidder** when
the clock hits zero and win the whole pot; every bid speeds the clock up (1h → 5min). Even if
you're outbid, each bid mints you a claim worth **110%** of your bid, paid back from later bids.

## Live URLs
- **Mini-app (embedded + standalone):** https://koeppelmann.github.io/CirclesTools/dollarAuction/miniapp.html
- Standalone web version (QR only): https://koeppelmann.github.io/CirclesTools/dollarAuction/

## Pitch (one line)
A self-running, on-chain dollar auction in group Circles: one tap to bid, last bidder wins the
pot, everyone else gets paid back +10% from the bids that follow them.

## How it uses Circles primitives
- Accepts **only** one group's Circles (the contract registers as a Circles **organization**
  and trusts exactly that group avatar; token id = `uint256(uint160(group))`).
- A bid is an **ERC-1155 transfer of the group token** to the contract; the contract's
  `onERC1155Received` / `onERC1155BatchReceived` splits it (10% pot / 10% host / 80% FIFO
  claim queue) and mints the bidder a 110% claim. Late transfers auto-settle and refund.
- Reads live profiles (name + avatar) from `rpc.aboutcircles.com`.

## Architecture (both SKILL.md patterns in one file)
`miniapp.html` detects its environment with the `@aboutcircles/miniapp-sdk` postMessage bridge
(inlined, ~2 KB, no external CDN on the critical path):

- **Embedded** (inside the Circles host): `isMiniappMode()` is true → `onWalletChange` supplies
  the Safe address, and the **Place bid** button submits the bid via `sendTransactions([...])`.
  The bid is a **trust-path payment**: the app calls the `circlesV2_findPath` pathfinder
  (`rpc.aboutcircles.com`), builds the flow matrix, and submits
  `Hub.operateFlowMatrix(flowVertices, flow, streams, packedCoordinates)`. Because the contract
  trusts only the group, the path necessarily delivers the group token on its terminal edge(s).
  This works whether or not the user holds the group token directly. If the pathfinder is
  unreachable it falls back to a direct `Hub.safeTransferFrom(you, contract, groupTokenId, amount, 0x)`,
  and there's always the "Pay via the Gnosis app" link. Settling the winner and recovering a
  failed payout also go through `sendTransactions`.
- **Standalone** (regular browser): falls back to a **Gnosis-app deep-link QR** for the bid.

## Contracts (Gnosis Chain, Etherscan-verified)
- **`CirclesDollarAuctionHub`** (the perpetual host the UI points at): `0x003D222feA904941bf28402422aCB2013e84300F`
  — registered once as a Circles org, trusts the group, and runs an unbounded sequence of games.
  **Whenever no game is running, anyone starts the next one by sending 10,000–1,000,000 group CRC to it**
  (the sender becomes that game's owner; bid time / bid size are read from the transfer `data`, or
  sensible defaults are used). It exposes `currentGameInfo()` and `canStart()` for the front-end.
- **`CirclesDollarAuctionFactory`**: `0xC1179A884849b3940610F8E152e9bAd56A4DeD04` — deploys hubs and
  keeps a registry (`allDeployments()`).
- `CirclesDollarAuction` (the original single-game contract) remains in this folder for reference.
- Hub: `0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8`; accepted group
  `0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c`. Source + Foundry tests in this folder.
- Per-game bounds: seed 10k–1m CRC; start/end clocks 5min–1day with end ≤ start; bid ≤ 1/10 of the seed.
  Includes the audit fixes (M-1 late-bid refund-before-settle, L-1 recover caps to balance).

## Registering on the Circles garage
1. Builder profile: https://garage.aboutcircles.com/signup
2. Register the app: https://garage.aboutcircles.com/register — name **Circles Dollar Auction**,
   the pitch above, live URL = the miniapp.html link, repo = this folder, README = this file.
3. Submit before the Sunday deadline for that cycle's judging.
