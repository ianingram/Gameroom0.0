import { DurableObject } from "cloudflare:workers";

// =============================================================================
//  Chess referee — Cloudflare Worker + Durable Object
// -----------------------------------------------------------------------------
//  One GameRoom Durable Object instance per room code. Both players open a
//  WebSocket to the SAME room (same code => same DO instance => strong
//  consistency). The DO is the authoritative referee: it assigns colors,
//  tracks whose turn it is, rejects out-of-turn moves, and relays each valid
//  move to the opponent. It does NOT validate chess legality — the game client
//  already does that. The referee only enforces turn order and relays.
//
//  Uses the WebSocket Hibernation API so the DO can be evicted from memory
//  while players think, without dropping their connections or incurring
//  duration charges. In-memory state is rebuilt in the constructor from the
//  sockets' serialized attachments; authoritative game state (turn + move
//  list) lives in Durable Object storage so it survives hibernation and lets
//  a reconnecting client resync.
// =============================================================================

// ---- Worker: route WebSocket upgrades to the right room ----
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health / info endpoint.
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        "chess-referee online. Connect a WebSocket to /room/<code>?name=<player>",
        { status: 200, headers: { "Content-Type": "text/plain" } }
      );
    }

    // /room/<code>  — the only WebSocket route.
    const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,32})$/);
    if (match) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket Upgrade request", { status: 426 });
      }
      const code = match[1].toLowerCase();
      // getByName maps a string to a stable Durable Object instance.
      const stub = env.GAME_ROOM.getByName(code);
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ---- Durable Object: one chess room ----
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    // sessions: live view of connected sockets, rebuilt after hibernation.
    this.sessions = new Map(); // WebSocket -> { id, color, name, room }
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att) this.sessions.set(ws, att);
    }
    // Cheap keepalive: a bare "ping" gets an automatic "pong" WITHOUT waking
    // the hibernated Durable Object, so it costs nothing.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  // -- New connection --
  async fetch(request) {
    const url = new URL(request.url);
    const room = (url.pathname.split("/")[2] || "").toLowerCase();
    const name = (url.searchParams.get("name") || "").slice(0, 24);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Decide color from colors ALREADY held by accepted sockets (the new
    // socket is not in getWebSockets() until acceptWebSocket runs).
    const taken = this._colorsPresent();
    let color;
    if (!taken.has("w")) color = "w";
    else if (!taken.has("b")) color = "b";
    else color = null; // room already has two players

    this.ctx.acceptWebSocket(server);

    const id = crypto.randomUUID();
    const att = { id, color, name, room };
    server.serializeAttachment(att);
    this.sessions.set(server, att);

    if (color === null) {
      // Spectators not supported in v1 — politely refuse the third joiner.
      this._send(server, { type: "full" });
      server.close(4001, "Room already has two players");
      this.sessions.delete(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Tell the new player who they are, and replay the game so far so a
    // reconnect / refresh catches up to the current position.
    const turn = (await this.ctx.storage.get("turn")) || "w";
    const moves = (await this.ctx.storage.get("moves")) || [];
    this._send(server, { type: "welcome", you: id, color, room });
    this._send(server, { type: "state", turn, moves });

    // If both colors are now present, the game can begin.
    const present = this._colorsPresent();
    if (present.has("w") && present.has("b")) {
      this._broadcast({ type: "start", turn });
    } else {
      this._send(server, { type: "waiting" });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // -- Incoming message from a client --
  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return; // ignore non-JSON (e.g. stray keepalive text)
    }

    const att = ws.deserializeAttachment() || {};
    const color = att.color;

    if (msg.type === "move") {
      if (color !== "w" && color !== "b") {
        return this._send(ws, { type: "error", reason: "not_a_player" });
      }
      // Both players must be present before moves count.
      const present = this._colorsPresent();
      if (!(present.has("w") && present.has("b"))) {
        return this._send(ws, { type: "error", reason: "waiting_for_opponent" });
      }
      const turn = (await this.ctx.storage.get("turn")) || "w";
      if (color !== turn) {
        return this._send(ws, { type: "error", reason: "not_your_turn" });
      }

      const move = {
        from: String(msg.from || ""),
        to: String(msg.to || ""),
        promotion: msg.promotion || null,
        by: color,
      };
      const moves = (await this.ctx.storage.get("moves")) || [];
      moves.push(move);
      const nextTurn = turn === "w" ? "b" : "w";
      // Persist authoritative state BEFORE relaying so a crash can't desync.
      await this.ctx.storage.put("moves", moves);
      await this.ctx.storage.put("turn", nextTurn);

      // Relay to the opponent; ack the mover.
      this._broadcast({ type: "move", ...move }, ws);
      this._send(ws, { type: "accepted", turn: nextTurn });
      return;
    }

    if (msg.type === "reset") {
      await this.ctx.storage.put("moves", []);
      await this.ctx.storage.put("turn", "w");
      this._broadcast({ type: "reset", turn: "w" }); // everyone, incl. sender
      return;
    }

    if (msg.type === "hello") {
      att.name = String(msg.name || "").slice(0, 24);
      ws.serializeAttachment(att);
      this.sessions.set(ws, att);
      return;
    }
  }

  async webSocketClose(ws, code, reason) {
    const att = this.sessions.get(ws) || ws.deserializeAttachment() || {};
    this.sessions.delete(ws);
    // Tell whoever is left that their opponent dropped. Their color slot is
    // now free, so a reconnecting player can reclaim it and resync via state.
    if (att.color === "w" || att.color === "b") {
      this._broadcast({ type: "opponent_disconnected", color: att.color }, ws);
    }
    try { ws.close(code, reason); } catch {}
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
  }

  // ---- helpers ----
  _colorsPresent() {
    const set = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && (a.color === "w" || a.color === "b")) set.add(a.color);
    }
    return set;
  }

  _send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  _broadcast(obj, except) {
    const data = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(data); } catch {}
    }
  }
}
