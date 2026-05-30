# chess-referee

A tiny Cloudflare **Worker + Durable Object** that relays chess moves between
two players in real time over WebSockets. One Durable Object instance per room
code; the object is the authoritative referee for whose turn it is.

It does **not** know the rules of chess — your game client validates legality.
The referee only: assigns colors, enforces turn order, relays each valid move
to the opponent, and keeps an authoritative move log so a reconnecting player
can resync.

Built on the WebSocket **Hibernation API**, so while players think the object
sleeps and you are not billed for idle time. On the Workers Free plan this is
effectively free for personal use.

---

## Prerequisites

- A Cloudflare account (you have one).
- Node.js installed.
- Wrangler (the Cloudflare CLI). `npm install` in this folder pulls it in, or
  install the latest globally with `npm install -g wrangler@latest`.

## Run locally

```bash
cd chess-referee
npm install
npx wrangler dev
```

Wrangler prints a local URL, usually `http://localhost:8787`. The WebSocket URL
is the same host with `ws://`, e.g. `ws://localhost:8787`.

Now open **`test-client.html`** in two browser tabs:

1. Leave the server box as `ws://localhost:8787`, room `test1`, click **Connect**
   in both tabs.
2. The first tab becomes **White**, the second **Black**, and both log `start`.
3. In the White tab, send a move (e.g. `e2` -> `e4`). The Black tab logs
   `OPPONENT moved e2 -> e4`.
4. Try sending a move from the **wrong** tab (White again, before Black replies).
   The referee answers `ERROR: not_your_turn` — turn enforcement works.
5. Close one tab; the other logs `opponent_disconnected`. Reopen and reconnect to
   the same room; it receives a `state` sync with the moves so far.

## Deploy

```bash
npx wrangler deploy
```

Wrangler gives you a public URL like
`https://chess-referee.YOURNAME.workers.dev`. The WebSocket URL is the same with
`wss://`, e.g. `wss://chess-referee.YOURNAME.workers.dev`. Put that into the test
client's server box (from any device) to play across the internet.

> First deploy will prompt you to log in (`wrangler login`) and may ask to
> enable the Workers Free plan if you have not already.

---

## Message protocol (the contract the game client implements)

Connect to: `wss://<host>/room/<code>?name=<player>`

**Server → client**

| type                    | fields                | meaning                                            |
|-------------------------|-----------------------|----------------------------------------------------|
| `welcome`               | `color`, `you`, `room`| your assigned color (`w` first, `b` second)        |
| `state`                 | `turn`, `moves[]`     | full resync — replay `moves` from the start        |
| `waiting`               | —                     | you are in; waiting for the second player          |
| `start`                 | `turn`                | both players present, play may begin               |
| `move`                  | `from`, `to`, `promotion`, `by` | opponent's move — apply it to your board |
| `accepted`              | `turn`                | your move was accepted; it is now `turn`'s move    |
| `reset`                 | `turn`                | game was reset — clear your board                  |
| `opponent_disconnected` | `color`               | the other player dropped                           |
| `full`                  | —                     | room already has two players (then closes)         |
| `error`                 | `reason`              | `not_your_turn` / `not_a_player` / `waiting_for_opponent` |

**Client → server**

| type    | fields                      | meaning                          |
|---------|-----------------------------|----------------------------------|
| `move`  | `from`, `to`, `promotion?`  | you made this move locally       |
| `reset` | —                           | start a new game                 |
| `hello` | `name`                      | set/update your display name     |
| `"ping"`| (bare string, not JSON)     | keepalive; auto-answered `pong`  |

### How the game client will use this (next step)

- On connect: store your `color`. On `state`, replay each move through the
  game's existing move funnel `attemptMoveWithCaptures(from, to)` to catch up.
- On `start`: enable the board (use the pass-and-play turn lock you already
  built, keyed to your own color).
- Local human move: apply it locally, then `ws.send({type:"move",from,to})`.
- On `move` from the server: call `attemptMoveWithCaptures(from, to)` so the
  opponent's move lands on your board.
- Send a bare `"ping"` every ~30s to keep the connection warm.

---

## Notes / v1 limitations

- Exactly two players per room; a third is refused with `full`.
- The referee enforces *turn order*, not chess legality (the client does that).
  A malicious client could send an illegal-but-in-turn move; for a friendly
  two-player game that is fine. Server-side legality is a future hardening step.
- Reconnect reclaims a freed color slot and resyncs via `state`. Mid-game
  identity persistence (guaranteeing you get *your* color back) is a refinement.
