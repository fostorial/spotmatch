"use strict";

(function () {
  const gameData = JSON.parse(document.getElementById("game-data").textContent);
  const symbols = JSON.parse(document.getElementById("symbols-data").textContent);
  const { gameId, wsToken, ownerId, currentUserId, deckId, isGuest, roomFull: initialRoomFull } = gameData;

  // ── DOM refs ────────────────────────────────────────────────
  const lobbyView = document.getElementById("lobby-view");
  const gameView = document.getElementById("game-view");
  const gameoverView = document.getElementById("gameover-view");
  const playersList = document.getElementById("players-list");
  const waitingMsg = document.getElementById("waiting-msg");
  const playerCountLabel = document.getElementById("player-count-label");
  const shareBtn = document.getElementById("share-btn");
  const startBtn = document.getElementById("start-btn");
  const centerCardEl = document.getElementById("center-card");
  const handCardEl = document.getElementById("hand-card");
  const scoreboardEl = document.getElementById("scoreboard");
  const roundStatusEl = document.getElementById("round-status");
  const finalScoresEl = document.getElementById("final-scores");
  const connStatusEl = document.getElementById("connection-status");
  // Room-full modal
  const roomFullModal      = document.getElementById("room-full-modal");
  const roomFullRefreshBtn = document.getElementById("room-full-refresh-btn");
  // Quit
  const lobbyQuitBtn = document.getElementById("lobby-quit-btn");
  const gameQuitBtn = document.getElementById("game-quit-btn");
  const quitModal = document.getElementById("quit-modal");
  const quitModalBody = document.getElementById("quit-modal-body");
  const quitCancelBtn = document.getElementById("quit-cancel-btn");
  const quitConfirmBtn = document.getElementById("quit-confirm-btn");

  // ── State ───────────────────────────────────────────────────
  let claimLocked = false;
  let myHandCard = null;
  let timerInterval = null;
  let isQuitting = false;           // true while an intentional quit is in flight
  const exitUrl = isGuest ? "/" : `/decks/${deckId}`;

  // ── WebSocket ───────────────────────────────────────────────
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${protocol}//${location.host}/ws?gameId=${encodeURIComponent(gameId)}&token=${encodeURIComponent(wsToken)}`
  );

  ws.addEventListener("message", (event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (_) {}
  });

  ws.addEventListener("close", () => {
    if (!isQuitting) {
      showConnectionStatus("Connection lost. Please refresh the page.");
    }
  });

  ws.addEventListener("error", () => {
    if (!isQuitting) {
      showConnectionStatus("Connection error. Please refresh the page.");
    }
  });

  // ── Share button ────────────────────────────────────────────
  if (shareBtn) {
    shareBtn.addEventListener("click", () => {
      const url = location.href;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => {
          shareBtn.textContent = "Link copied!";
          setTimeout(() => {
            shareBtn.textContent = "Copy invite link";
          }, 2000);
        });
      } else {
        prompt("Copy this link to invite others:", url);
      }
    });
  }

  // ── Start button (owner only) ───────────────────────────────
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      startBtn.disabled = true;
      startBtn.textContent = "Starting…";
      ws.send(JSON.stringify({ type: "start-game" }));
    });
  }

  // ── Message handler ─────────────────────────────────────────
  function handleMessage(msg) {
    switch (msg.type) {
      case "lobby-state":
        renderPlayerList(msg.players, msg.ownerId);
        break;
      case "player-joined":
        upsertPlayerItem(msg.player);
        break;
      case "player-left":
        removePlayerItem(msg.userId);
        break;
      case "game-started":
        showView("game");
        startTimer(msg.startedAt);
        break;
      case "round-start":
        myHandCard = msg.yourCard;        // raw symbol indices, used for claim-match
        claimLocked = false;
        renderRound(msg.centerLayout, msg.handLayout, msg.scores);
        break;
      case "round-won":
        onRoundWon(msg);
        break;
      case "wrong-guess":
        onWrongGuess();
        break;
      case "game-over":
        showGameOver(msg.results);
        break;
      case "game-state":
        // Reconnected mid-game
        myHandCard = msg.yourCard;
        claimLocked = false;
        showView("game");
        startTimer(msg.startedAt);
        renderRound(msg.centerLayout, msg.handLayout, msg.scores);
        break;
      case "room-full":
        showRoomFull();
        break;
      case "game-disbanded":
        onGameDisbanded(msg.reason);
        break;
      case "error":
        showConnectionStatus(msg.message);
        break;
    }
  }

  // ── Lobby rendering ─────────────────────────────────────────
  function renderPlayerList(players, ownerIdValue) {
    if (!playersList) return;
    playersList.innerHTML = "";
    players.forEach((p) => appendPlayerItem(p, ownerIdValue));
    updateLobbyFooter(players.length);
  }

  function appendPlayerItem(player, ownerIdValue) {
    const li = document.createElement("li");
    li.className = "player-item";
    li.dataset.userId = player.userId;

    const nameSpan = document.createElement("span");
    nameSpan.textContent = player.username;
    li.appendChild(nameSpan);

    if (player.userId === ownerIdValue) {
      const badge = document.createElement("span");
      badge.className = "owner-badge";
      badge.textContent = "Owner";
      li.appendChild(badge);
    }
    if (player.userId === currentUserId) {
      const youBadge = document.createElement("span");
      youBadge.className = "you-badge";
      youBadge.textContent = "You";
      li.appendChild(youBadge);
    }

    playersList.appendChild(li);
  }

  function upsertPlayerItem(player) {
    if (!playersList) return;
    // Avoid duplicates
    if (playersList.querySelector(`[data-user-id="${player.userId}"]`)) return;
    appendPlayerItem(player, ownerId);
    const count = playersList.querySelectorAll(".player-item").length;
    updateLobbyFooter(count);
  }

  function removePlayerItem(userId) {
    const el = playersList && playersList.querySelector(`[data-user-id="${userId}"]`);
    if (el) el.remove();
    const count = playersList ? playersList.querySelectorAll(".player-item").length : 0;
    updateLobbyFooter(count);
  }

  function updateLobbyFooter(count) {
    if (playerCountLabel) {
      playerCountLabel.textContent = `${count} player${count !== 1 ? "s" : ""}`;
    }
    if (waitingMsg) {
      if (currentUserId === ownerId) {
        if (count === 1) {
          waitingMsg.textContent = "You can play solo, or share the link to invite others before starting.";
        } else {
          waitingMsg.textContent = `${count} players ready. Start whenever you like!`;
        }
        if (startBtn) startBtn.disabled = false;
      } else {
        waitingMsg.textContent = "Waiting for the owner to start the game…";
      }
    }
  }

  // ── View switching ──────────────────────────────────────────
  function showView(name) {
    lobbyView.hidden = name !== "lobby";
    gameView.hidden = name !== "game";
    gameoverView.hidden = name !== "gameover";
  }

  // ── Game rendering ──────────────────────────────────────────
  function renderRound(centerLayout, handLayout, scores) {
    renderCard(centerCardEl, centerLayout, false);
    renderCard(handCardEl, handLayout, true);
    renderScoreboard(scores);
    setRoundStatus("Find the matching symbol!", "active");
  }

  // Render a card using the exact same ratio-based positioning as deck-detail.ejs.
  // layout — array of { symIdx, xRatio, yRatio, sizeRatio, angle } from the server
  // clickable — true for the player's hand card
  function renderCard(el, layout, clickable) {
    el.innerHTML = "";
    if (!layout || layout.length === 0) {
      el.innerHTML = '<p class="game-card-empty">No card</p>';
      return;
    }

    layout.forEach(({ symIdx, xRatio, yRatio, sizeRatio, angle }) => {
      const sym = symbols[symIdx] || { label: `Symbol ${symIdx + 1}`, imageData: null };

      const div = document.createElement("div");
      div.className = "card-symbol" + (clickable ? " card-symbol-clickable" : "");
      div.dataset.symIdx = symIdx;

      // Identical CSS to the EJS card preview:
      //   left: calc(50% + xRatio*100%)
      //   top:  calc(50% + yRatio*100%)
      //   width / height: sizeRatio*100%
      //   transform: translate(-50%,-50%) rotate(Xdeg)
      div.style.left      = `calc(50% + ${(xRatio * 100).toFixed(3)}%)`;
      div.style.top       = `calc(50% + ${(yRatio * 100).toFixed(3)}%)`;
      div.style.width     = `${(sizeRatio * 100).toFixed(3)}%`;
      div.style.height    = `${(sizeRatio * 100).toFixed(3)}%`;
      div.style.transform = `translate(-50%, -50%) rotate(${angle.toFixed(1)}deg)`;

      const img = document.createElement("img");
      img.src      = sym.imageData || "/favicon.png";
      img.alt      = sym.label;
      img.draggable = false;
      div.appendChild(img);

      if (clickable) {
        div.addEventListener("click", () => onSymbolClick(symIdx));
      }

      el.appendChild(div);
    });
  }

  function onSymbolClick(symIdx) {
    if (claimLocked) return;
    claimLocked = true;
    ws.send(JSON.stringify({ type: "claim-match", symbolIndex: symIdx }));
  }

  function onRoundWon(msg) {
    claimLocked = true;
    const isWinner = msg.winnerId === currentUserId;
    setRoundStatus(
      isWinner ? "You found it! +1 point" : `${escHtml(msg.winnerName)} found the match first!`,
      isWinner ? "success" : "info"
    );
    // Highlight the winning symbol on both cards
    highlightSymbol(centerCardEl, msg.matchSymbol);
    highlightSymbol(handCardEl, msg.matchSymbol);
    renderScoreboard(msg.scores);
  }

  function onWrongGuess() {
    claimLocked = false; // Allow another attempt
    setRoundStatus("Not quite — keep looking!", "error");
    setTimeout(() => {
      if (!claimLocked) setRoundStatus("Find the matching symbol!", "active");
    }, 1200);
  }

  function highlightSymbol(cardEl, symIdx) {
    cardEl.querySelectorAll(".card-symbol").forEach((el) => {
      if (Number(el.dataset.symIdx) === symIdx) {
        el.classList.add("card-symbol-match");
      } else {
        el.classList.add("card-symbol-dim");
      }
    });
  }

  function renderScoreboard(scores) {
    if (!scoreboardEl) return;
    scoreboardEl.innerHTML = scores
      .map(
        (s) =>
          `<div class="score-item${s.userId === currentUserId ? " score-me" : ""}">
            <span class="score-name">${escHtml(s.username)}</span>
            <span class="score-value">${s.score}</span>
          </div>`
      )
      .join("");
  }

  function setRoundStatus(text, type) {
    if (!roundStatusEl) return;
    roundStatusEl.textContent = text;
    roundStatusEl.className = `round-status round-status-${type}`;
  }

  // ── Room-full ────────────────────────────────────────────────
  function showRoomFull() {
    isQuitting = true; // suppress "connection lost" — this is expected
    if (roomFullModal) roomFullModal.hidden = false;
  }

  // "Check again" — reload the page so the server re-evaluates capacity
  if (roomFullRefreshBtn) {
    roomFullRefreshBtn.addEventListener("click", () => {
      location.reload();
    });
  }

  // Show immediately if the server already told us the room is full on page load
  if (initialRoomFull && roomFullModal) {
    roomFullModal.hidden = false;
  }

  // ── Quit ────────────────────────────────────────────────────
  function openQuitModal(inGame) {
    if (!quitModal) return;
    const isOwner = currentUserId === ownerId;
    if (quitModalBody) {
      quitModalBody.textContent = isOwner
        ? "You are the host. Leaving will end the game for all players."
        : (inGame ? "You will leave the current game." : "You will leave the lobby.");
    }
    quitModal.hidden = false;
    quitConfirmBtn && quitConfirmBtn.focus();
  }

  function closeQuitModal() {
    if (quitModal) quitModal.hidden = true;
  }

  function confirmQuit() {
    closeQuitModal();
    isQuitting = true;
    stopTimer();
    ws.send(JSON.stringify({ type: "quit" }));
    // Navigate immediately — the server will close the socket on its end
    // after broadcasting to others. We don't wait for the close event.
    setTimeout(() => { location.href = exitUrl; }, 50);
  }

  if (lobbyQuitBtn) {
    lobbyQuitBtn.addEventListener("click", () => openQuitModal(false));
  }
  if (gameQuitBtn) {
    gameQuitBtn.addEventListener("click", () => openQuitModal(true));
  }
  if (quitCancelBtn) {
    quitCancelBtn.addEventListener("click", closeQuitModal);
  }
  if (quitConfirmBtn) {
    quitConfirmBtn.addEventListener("click", confirmQuit);
  }
  // Close modal on backdrop click
  if (quitModal) {
    quitModal.addEventListener("click", (e) => {
      if (e.target === quitModal) closeQuitModal();
    });
  }
  // Close modal on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && quitModal && !quitModal.hidden) closeQuitModal();
  });

  function onGameDisbanded(reason) {
    isQuitting = true; // suppress "connection lost" if socket closes next
    stopTimer();
    // Show the gameover view with the disbandment reason instead of scores
    showView("gameover");
    if (finalScoresEl) {
      finalScoresEl.innerHTML =
        `<li class="final-score-item"><span class="final-name">${escHtml(reason || "The game was ended.")}</span></li>`;
    }
    // Hide the "Play again" button since the game was disbanded, not finished
    const playAgainBtn = document.querySelector("#gameover-view .hero-actions .button:not(.button-secondary)");
    if (playAgainBtn) playAgainBtn.hidden = true;
  }

  // ── Timer ───────────────────────────────────────────────────
  function startTimer(startedAt) {
    stopTimer();
    const timerEl = document.getElementById("game-timer");
    if (!timerEl || !startedAt) return;

    function tick() {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const secs = String(elapsed % 60).padStart(2, "0");
      timerEl.textContent = `${mins}:${secs}`;
    }
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // ── Game over ───────────────────────────────────────────────
  function showGameOver(results) {
    stopTimer();
    showView("gameover");
    if (!finalScoresEl) return;
    finalScoresEl.innerHTML = results
      .map(
        (r, i) =>
          `<li class="final-score-item${r.userId === currentUserId ? " score-me" : ""}">
            <span class="final-rank">${i + 1}</span>
            <span class="final-name">${escHtml(r.username)}</span>
            <span class="final-score">${r.score} pt${r.score !== 1 ? "s" : ""}</span>
          </li>`
      )
      .join("");
  }

  // ── Helpers ─────────────────────────────────────────────────
  function showConnectionStatus(msg) {
    if (!connStatusEl) return;
    connStatusEl.textContent = msg;
    connStatusEl.hidden = false;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
