# SqueekRaid

**A pixel river raid flown on a real hamster's wheel.**

SqueekRaid is a free browser arcade game for [Squeekchain](https://squeekchain.com). You fly a small
plane down a river, shoot the cats, collect seeds to keep your fuel up and go as far as you can. The
river comes from Squeektoshi, the hamster whose wheel powers Squeekchain. Busy half-hours on his wheel
become tight canyons, and quiet ones become wide water.

- Play: <https://squeekraid.xyz> (practice is open; online play is in a closed beta)
- X: [@SqueekRaid](https://x.com/SqueekRaid)

squeekchain-project: ffe33607-2770-4e50-9845-36ebf99414a0

## How it uses Squeekchain

| Squeekchain data | What it does in the game |
| --- | --- |
| Wheel work in half-hour buckets (`/v1/measurement/stats`) | Shapes each route. 48 buckets set the river's width, enemies and Block Crates along the flight. |
| One wheel day, 12:00 to 12:00 UTC | Becomes the **Daily** route two days later. Each Daily records the true wheel day it comes from. |
| Squeektoshi's first recorded night (2026-10-26) | The fixed **Genesis** route, the all-time challenge. |
| Live status (`/v1/status`) and run segments (`/v1/measurement/runs`) | The live wheel state (running, resting, delayed, no data). **Live Drops**, cosmetic only, can appear only while the official data shows him running. |
| Wallet signature (Sign-In with Ethereum) and X | Account and leaderboard identity. Signing in costs no gas and moves no funds. |

The live state is strict. **Running** needs a fresh hardware observation from the official
installation, with a signer and an accepted run profile. A resting wheel stays **resting** while
Squeekchain's once-a-minute report is fresh. Older data reads **delayed**, then **no data**. Earlier
activity is never shown as current activity.

## What is in this repository

This is the source of the game client and the parts that connect it to Squeekchain. It comes from
the private SqueekRaid repository, which also holds the servers and the operations.

| Path | Contents |
| --- | --- |
| `apps/game` | The game client: rendering, input (keyboard and touch), the Hangar, settings, practice mode, and the online client (wallet and X sign-in, flight socket). Builds into one self-contained HTML page. |
| `apps/site` | The homepage of squeekraid.xyz (HTML and CSS; the links and security headers are filled in by the deployment build, which is not included), and the small script that shows the signed-in state. |
| `packages/sim` | The deterministic flight simulation (rules v3). The same code runs in the browser and on the server, which replays every online flight from its inputs to verify it. |
| `packages/routes` | The route catalogue. It turns 48 wheel buckets into a river, and includes the recorded wheel days that ship with the game. |
| `packages/protocol` | The flight socket messages, and the client side of Gear activation. |
| `packages/domain/activity` | The Squeekchain adapter: a typed client for the public API (`/v1/status`, `/v1/measurement/runs`, `/v1/measurement/stats`), the live-state detector, and the wheel buckets that become a Daily route. Pure functions with their tests; the server's polling, storage and scheduling stay private. |

Not included: the API, flight gateway, verifier, admin console, database schema and queries, the
Squeekchain poller and Daily scheduler, anti-cheat and review rules, infrastructure and deployment
configuration, credentials and player data.

## Build and test

Requires Node.js 22.18 or later and pnpm.

```bash
pnpm install
pnpm build:game        # writes apps/game/dist/index.html (practice mode, no server needed)
pnpm typecheck
pnpm test              # simulation, Squeekchain adapter and client unit tests
```

Open `apps/game/dist/index.html` in a browser to play practice mode. The simulation build hash
printed by `node -e "import('./packages/sim/src/v3/build-hash.ts').then(m => console.log(m.simV3BuildSha256()))"`
is the same as the one the live game uses.

## Notes

- Squeekchain currently runs on the Sepolia testnet. SqueekRaid sends no transactions. Nothing in
  the game is for sale, and Gear and cosmetics are in-game items, not tokens or NFTs.
- Fonts in `apps/game/fonts` are under the SIL Open Font License (see the `OFL-*.txt` files there).

© 2026 SqueekRaid. All rights reserved. The source is published so it can be reviewed. It is not
licensed for reuse.
