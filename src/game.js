"use strict";

const crypto = require("crypto");

// Map<gameId, Game>
const games = new Map();
// Map<token, TokenData>
const wsTokens = new Map();

// Cards are stored as { symIndices: number[], cardIdx: number }
// symIndices — the symbol indices that appear on this card
// cardIdx    — the card's original position in buildSpotMatchIndexCards(), used
//              to reproduce the exact same seeded layout as the PDF export

const CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getScores(game) {
  return Array.from(game.players.values())
    .map((p) => ({ userId: p.userId, username: p.username, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

// ── Cleanup timer ─────────────────────────────────────────────────────────────

function scheduleCleanup(game) {
  cancelCleanup(game);
  game.cleanupTimer = setTimeout(() => {
    disbandGame(game, "Game expired — all players disconnected.");
  }, CLEANUP_DELAY_MS);
}

function cancelCleanup(game) {
  if (game.cleanupTimer) {
    clearTimeout(game.cleanupTimer);
    game.cleanupTimer = null;
  }
}

// ── Game lifecycle ────────────────────────────────────────────────────────────

// deckTitle is stored so the public game listing can display it without a DB query.
function createGame(deckId, ownerId, ownerName, deckTitle, maxPlayers, isPublic) {
  const id = crypto.randomUUID();
  games.set(id, {
    id,
    deckId,
    deckTitle:    String(deckTitle || ""),
    ownerId,
    ownerName,
    maxPlayers:   Math.max(1, Math.min(8, Number(maxPlayers) || 4)),
    isPublic:     Boolean(isPublic),
    players:      new Map(),     // userId -> { userId, username, score, handCard }
    connections:  new Map(),     // userId -> ws
    status:       "lobby",
    drawPile:     [],            // remaining { symIndices, cardIdx } objects
    centerCard:   null,          // current center { symIndices, cardIdx }
    roundActive:  false,
    startedAt:    null,
    cleanupTimer: null,
    createdAt:    Date.now()
  });
  return id;
}

function getGame(id) {
  return games.get(id) || null;
}

// Returns true when a player who is NOT already in the game would push it over capacity.
function isRoomFull(game, userId) {
  return !game.players.has(userId) && game.players.size >= game.maxPlayers;
}

// Returns a serialisable summary of every public, non-ended game.
function getPublicGames() {
  const result = [];
  for (const game of games.values()) {
    if (!game.isPublic || game.status === "ended") continue;
    result.push({
      id:          game.id,
      deckTitle:   game.deckTitle,
      ownerName:   game.ownerName,
      playerCount: game.players.size,
      maxPlayers:  game.maxPlayers,
      status:      game.status
    });
  }
  return result;
}

// ── WS token ──────────────────────────────────────────────────────────────────

function createWsToken(userId, username, gameId) {
  const token = crypto.randomUUID();
  wsTokens.set(token, { userId, username, gameId, expires: Date.now() + 60_000 });
  return token;
}

function consumeWsToken(token) {
  const data = wsTokens.get(token);
  if (!data) return null;
  if (data.expires < Date.now()) {
    wsTokens.delete(token);
    return null;
  }
  wsTokens.delete(token);
  return data;
}

// ── Messaging helpers ─────────────────────────────────────────────────────────

function broadcast(game, message) {
  const data = JSON.stringify(message);
  for (const ws of game.connections.values()) {
    if (ws.readyState === 1 /* OPEN */) ws.send(data);
  }
}

function sendTo(ws, message) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
}

// ── Game logic ────────────────────────────────────────────────────────────────

// Start the game.
// allCards — array of { symIndices, cardIdx } produced by the caller from
//            buildSpotMatchIndexCards().
// onRoundStart(game) — called whenever a new round begins so server.js can
//   enrich the message with card layouts from the seeded PDF algorithm.
function startGame(game, allCards, onRoundStart) {
  const shuffled = shuffle(allCards);
  const playerIds = Array.from(game.players.keys());

  for (const userId of playerIds) {
    if (shuffled.length === 0) break;
    game.players.get(userId).handCard = shuffled.pop();
  }

  game.centerCard = shuffled.length > 0 ? shuffled.pop() : null;
  game.drawPile   = shuffled;
  game.status     = "playing";
  game.roundActive = true;
  game.startedAt  = Date.now();

  broadcast(game, { type: "game-started", startedAt: game.startedAt });
  onRoundStart(game);
}

// Handle a player claiming a match.
function handleClaim(game, userId, symbolIndex, onRoundStart) {
  if (!game.roundActive) return;

  const player = game.players.get(userId);
  if (!player || !player.handCard) return;

  const onHand   = player.handCard.symIndices.includes(symbolIndex);
  const onCenter = game.centerCard && game.centerCard.symIndices.includes(symbolIndex);

  if (!onHand || !onCenter) {
    const ws = game.connections.get(userId);
    sendTo(ws, { type: "wrong-guess" });
    return;
  }

  game.roundActive = false;
  player.score++;

  const scores = getScores(game);
  broadcast(game, {
    type:        "round-won",
    winnerId:    userId,
    winnerName:  player.username,
    matchSymbol: symbolIndex,
    scores
  });

  const oldHand  = player.handCard;
  player.handCard = game.drawPile.length > 0 ? game.drawPile.pop() : null;
  game.centerCard = oldHand;

  const anyoneCanPlay = Array.from(game.players.values()).some((p) => p.handCard !== null);
  if (!anyoneCanPlay || game.centerCard === null) {
    game.status = "ended";
    setTimeout(() => {
      broadcast(game, { type: "game-over", results: getScores(game) });
    }, 1800);
    return;
  }

  setTimeout(() => {
    if (game.status !== "playing") return;
    game.roundActive = true;
    onRoundStart(game);
  }, 1800);
}

// Cleanly end a game: broadcast reason, close every socket, delete from store.
function disbandGame(game, reason) {
  cancelCleanup(game);
  game.status = "ended";
  broadcast(game, { type: "game-disbanded", reason: reason || "The host ended the game." });
  for (const ws of game.connections.values()) {
    try { ws.close(1000, "Game disbanded"); } catch (_) {}
  }
  games.delete(game.id);
}

module.exports = {
  createGame,
  getGame,
  isRoomFull,
  getPublicGames,
  disbandGame,
  scheduleCleanup,
  cancelCleanup,
  createWsToken,
  consumeWsToken,
  broadcast,
  sendTo,
  getScores,
  startGame,
  handleClaim
};
