(() => {
  "use strict";

  const ACTION_CARDS = [
    { type: "targetUp", label: "Raise Goal", text: "+3 target this round. Good when your hand is high." },
    { type: "targetDown", label: "Lower Goal", text: "-2 target this round. Good when your opponent is greedy." },
    { type: "addTally", label: "Heavy Push", text: "+1 saw movement for whoever loses this round." },
    { type: "guard", label: "Brace", text: "Block 1 saw movement if you lose this round." },
    { type: "swapHigh", label: "Cut High", text: "Replace your highest card with a fresh draw." },
    { type: "dropLow", label: "Drop Low", text: "Discard your lowest card. Requires 3+ cards." },
  ];

  const els = {};
  let mode = "menu";
  let state = null;
  let socket = null;
  let you = null;
  let roomCode = null;
  let botTimer = null;
  let lastError = "";

  document.addEventListener("DOMContentLoaded", () => {
    cacheElements();
    bindEvents();
    els.nameInput.value = localStorage.getItem("sawline21:name") || "Player";
    render();
  });

  function cacheElements() {
    for (const id of [
      "menu",
      "game",
      "nameInput",
      "codeInput",
      "botBtn",
      "hostBtn",
      "joinBtn",
      "modeLabel",
      "roomLabel",
      "copyCodeBtn",
      "leaveBtn",
      "arenaCanvas",
      "roundLabel",
      "targetLabel",
      "tallyLabel",
      "statusText",
      "players",
      "drawBtn",
      "standBtn",
      "nextRoundBtn",
      "restartBtn",
      "actionCards",
      "logList",
    ]) {
      els[id] = document.getElementById(id);
    }
  }

  function bindEvents() {
    els.botBtn.addEventListener("click", startOfflineBot);
    els.hostBtn.addEventListener("click", hostRoom);
    els.joinBtn.addEventListener("click", () => connectRoom(els.codeInput.value));
    els.codeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") connectRoom(els.codeInput.value);
    });
    els.drawBtn.addEventListener("click", () => sendGameAction({ type: "draw" }));
    els.standBtn.addEventListener("click", () => sendGameAction({ type: "stand" }));
    els.nextRoundBtn.addEventListener("click", () => sendGameAction({ type: "nextRound" }));
    els.restartBtn.addEventListener("click", () => sendGameAction({ type: "restart" }));
    els.leaveBtn.addEventListener("click", leaveGame);
    els.copyCodeBtn.addEventListener("click", copyRoomCode);
    window.addEventListener("resize", () => drawArena(publicView()));
  }

  function playerName() {
    const cleaned = (els.nameInput.value || "Player").replace(/[<>]/g, "").trim().slice(0, 18) || "Player";
    localStorage.setItem("sawline21:name", cleaned);
    return cleaned;
  }

  function showGame(nextMode) {
    mode = nextMode;
    els.menu.classList.add("hidden");
    els.game.classList.remove("hidden");
  }

  function showMenu() {
    mode = "menu";
    state = null;
    you = null;
    roomCode = null;
    lastError = "";
    if (socket) socket.close();
    socket = null;
    clearTimeout(botTimer);
    els.menu.classList.remove("hidden");
    els.game.classList.add("hidden");
    render();
  }

  function startOfflineBot() {
    clearTimeout(botTimer);
    const human = playerName();
    state = createOfflineGame(human);
    you = state.players[0].id;
    roomCode = "BOT";
    showGame("offline");
    render();
    maybeBotTurn();
  }

  async function hostRoom() {
    lastError = "";
    if (location.protocol === "file:") {
      lastError = "Host mode needs wrangler dev or a deployed Cloudflare Worker. Offline bot mode works from a local file.";
      renderMenuError();
      return;
    }

    try {
      els.hostBtn.disabled = true;
      els.hostBtn.textContent = "Creating...";
      const response = await fetch("/api/new-room", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Room API returned ${response.status}.`);
      const payload = await response.json();
      await connectRoom(payload.code);
    } catch (error) {
      lastError = error.message || "Could not create a room.";
      renderMenuError();
    } finally {
      els.hostBtn.disabled = false;
      els.hostBtn.textContent = "Host Cloud Room";
    }
  }

  async function connectRoom(rawCode) {
    lastError = "";
    const code = normalizeRoomCode(rawCode);
    if (!code) {
      lastError = "Enter a room code first.";
      renderMenuError();
      return;
    }
    if (location.protocol === "file:") {
      lastError = "Join mode needs wrangler dev or a deployed Cloudflare Worker. Offline bot mode works from a local file.";
      renderMenuError();
      return;
    }

    if (socket) socket.close();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${location.host}/ws/${encodeURIComponent(code)}`;

    socket = new WebSocket(wsUrl);
    roomCode = code;
    you = null;
    state = {
      phase: "waiting",
      message: "Connecting...",
      round: 0,
      target: 21,
      tally: 1,
      saw: 0,
      sawLimit: 7,
      turn: 0,
      players: [],
      log: ["Connecting to cloud room..."],
    };
    showGame("online");
    render();

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "join", name: playerName(), roomCode: code }));
    });

    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "state") {
        state = payload.state;
        you = payload.you;
        roomCode = payload.roomCode || code;
        lastError = "";
        render();
      } else if (payload.type === "error") {
        lastError = payload.message;
        render();
      } else if (payload.type === "notice") {
        lastError = payload.message;
        render();
      }
    });

    socket.addEventListener("close", () => {
      if (mode === "online") {
        lastError = "Disconnected from the room.";
        render();
      }
    });

    socket.addEventListener("error", () => {
      lastError = "WebSocket error. Check that the Worker is running and /ws routes are enabled.";
      render();
    });
  }

  function sendGameAction(action) {
    lastError = "";
    if (mode === "online") {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        lastError = "Not connected to the room.";
        render();
        return;
      }
      socket.send(JSON.stringify(action));
      return;
    }

    if (mode === "offline") {
      try {
        runOfflineAction(action);
        render();
        maybeBotTurn();
      } catch (error) {
        lastError = error.message;
        render();
      }
    }
  }

  function leaveGame() {
    showMenu();
  }

  async function copyRoomCode() {
    if (!roomCode || roomCode === "BOT") return;
    try {
      await navigator.clipboard.writeText(roomCode);
      lastError = "Room code copied.";
    } catch {
      lastError = `Room code: ${roomCode}`;
    }
    render();
  }

  function renderMenuError() {
    if (lastError) alert(lastError);
  }

  function render() {
    const view = publicView();
    if (mode === "menu" || !view) return;

    els.modeLabel.textContent = mode === "online" ? "cloud room" : "offline bot";
    els.roomLabel.textContent = mode === "online" ? `Room ${roomCode || "..."}` : "Offline Bot Duel";
    els.copyCodeBtn.classList.toggle("hidden", mode !== "online" || !roomCode);

    els.roundLabel.textContent = view.round ? `Round ${view.round}` : "Waiting";
    els.targetLabel.textContent = `Target ${view.target || 21}`;
    els.tallyLabel.textContent = `Tally ${view.tally || 1}`;
    els.statusText.textContent = lastError || view.message || "Ready.";

    renderPlayers(view);
    renderControls(view);
    renderLog(view);
    drawArena(view);
  }

  function publicView() {
    if (!state) return null;
    if (mode === "offline") return publicStateFor(state, you);
    return state;
  }

  function renderPlayers(view) {
    const cardsHtml = view.players.map((player, index) => {
      const isYou = player.id === you;
      const active = view.phase === "playing" && view.turn === index;
      const totalText = player.total == null ? "hidden" : player.total;
      const statusBadges = [];
      if (isYou) statusBadges.push(`<span class="badge good">You</span>`);
      if (active) statusBadges.push(`<span class="badge">Turn</span>`);
      if (player.stood) statusBadges.push(`<span class="badge">Stood</span>`);
      if (player.busted) statusBadges.push(`<span class="badge bad">Bust</span>`);
      if (player.guard) statusBadges.push(`<span class="badge good">Guard ${player.guard}</span>`);
      if (!player.connected && mode === "online") statusBadges.push(`<span class="badge bad">Offline</span>`);
      if (!isYou && player.trumpCount) statusBadges.push(`<span class="badge">Actions ${player.trumpCount}</span>`);

      return `
        <article class="player-card ${isYou ? "you" : ""} ${active ? "active" : ""}">
          <div class="player-head">
            <div>
              <div class="player-name">${escapeHtml(player.name || `Player ${index + 1}`)}</div>
              <div class="player-meta">Total: ${escapeHtml(String(totalText))}</div>
            </div>
            <div class="player-meta">Seat ${index + 1}</div>
          </div>
          <div class="cards">
            ${player.hand.map(renderCard).join("") || `<span class="player-meta">No cards yet.</span>`}
          </div>
          <div class="player-states">${statusBadges.join("")}</div>
        </article>
      `;
    });

    if (cardsHtml.length === 1) {
      cardsHtml.push(`
        <article class="player-card">
          <div class="player-head">
            <div>
              <div class="player-name">Waiting...</div>
              <div class="player-meta">Share the room code with another player.</div>
            </div>
          </div>
          <div class="cards"></div>
        </article>
      `);
    }

    els.players.innerHTML = cardsHtml.join("");
  }

  function renderCard(card) {
    if (card.hidden) return `<div class="card hidden-card" aria-label="Hidden card"></div>`;
    return `<div class="card"><span>${card.value}</span><small>${escapeHtml(card.suit || "")}</small></div>`;
  }

  function renderControls(view) {
    const localIndex = view.players.findIndex((player) => player.id === you);
    const isMyTurn = view.phase === "playing" && view.turn === localIndex;
    const isRoundOver = view.phase === "roundOver";
    const isGameOver = view.phase === "gameOver";
    const waiting = view.phase === "waiting";

    els.drawBtn.disabled = !isMyTurn;
    els.standBtn.disabled = !isMyTurn;
    els.drawBtn.classList.toggle("hidden", waiting || isRoundOver || isGameOver);
    els.standBtn.classList.toggle("hidden", waiting || isRoundOver || isGameOver);
    els.nextRoundBtn.classList.toggle("hidden", !isRoundOver);
    els.restartBtn.classList.toggle("hidden", !isGameOver);

    const localPlayer = view.players[localIndex];
    if (!localPlayer || waiting || isRoundOver || isGameOver) {
      els.actionCards.innerHTML = "";
      return;
    }

    els.actionCards.innerHTML = localPlayer.trumps
      .map((card) => {
        const disabled = !isMyTurn || card.used;
        return `
          <button class="action-card ${card.used ? "used" : ""}" data-card-id="${escapeHtml(card.id)}" ${disabled ? "disabled" : ""}>
            <strong>${escapeHtml(card.label)}</strong>
            <span>${escapeHtml(card.text)}</span>
          </button>
        `;
      })
      .join("");

    for (const button of els.actionCards.querySelectorAll("button[data-card-id]")) {
      button.addEventListener("click", () => {
        sendGameAction({ type: "playTrump", cardId: button.dataset.cardId });
      });
    }
  }

  function renderLog(view) {
    const lines = (view.log || []).slice(-12);
    els.logList.innerHTML = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  }

  function drawArena(view) {
    const canvas = els.arenaCanvas;
    if (!canvas || !view) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(640, Math.floor(rect.width * dpr));
    canvas.height = Math.floor(260 * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const centerX = width / 2;
    const trackWidth = width * 0.78;
    const leftX = centerX - trackWidth / 2;
    const rightX = centerX + trackWidth / 2;
    const y = height * 0.55;
    const limit = view.sawLimit || 7;
    const clampedSaw = Math.max(-limit, Math.min(limit, view.saw || 0));
    const sawX = centerX + (clampedSaw / limit) * (trackWidth / 2);

    ctx.clearRect(0, 0, width, height);

    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, "#151d2c");
    bg.addColorStop(1, "#090c13");
    ctx.fillStyle = bg;
    roundRect(ctx, 0, 0, width, height, 20);
    ctx.fill();

    ctx.fillStyle = "rgba(239, 71, 111, 0.13)";
    roundRect(ctx, leftX - 28, y - 44, 68, 88, 18);
    ctx.fill();
    roundRect(ctx, rightX - 40, y - 44, 68, 88, 18);
    ctx.fill();

    ctx.strokeStyle = "rgba(255,255,255,0.26)";
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(leftX, y);
    ctx.lineTo(rightX, y);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 209, 102, 0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(centerX, y - 34);
    ctx.lineTo(centerX, y + 34);
    ctx.stroke();

    for (let mark = -limit; mark <= limit; mark += 1) {
      const x = centerX + (mark / limit) * (trackWidth / 2);
      ctx.strokeStyle = mark === 0 ? "rgba(255,209,102,0.85)" : "rgba(255,255,255,0.18)";
      ctx.lineWidth = mark === 0 ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(x, y - 14);
      ctx.lineTo(x, y + 14);
      ctx.stroke();
    }

    drawSaw(ctx, sawX, y, 34, performance.now() / 800);

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "800 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(view.players[0]?.name || "Left", leftX, y + 72);
    ctx.fillText(view.players[1]?.name || "Right", rightX, y + 72);

    const leftDanger = clampedSaw <= -limit;
    const rightDanger = clampedSaw >= limit;
    ctx.fillStyle = leftDanger || rightDanger ? "#ff5d5d" : "rgba(255,255,255,0.72)";
    ctx.fillText(`Saw position ${view.saw || 0}`, centerX, y - 62);
  }

  function drawSaw(ctx, x, y, radius, rotation) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.beginPath();
    const teeth = 18;
    for (let i = 0; i < teeth * 2; i += 1) {
      const angle = (Math.PI * 2 * i) / (teeth * 2);
      const r = i % 2 === 0 ? radius : radius * 0.72;
      const px = Math.cos(angle) * r;
      const py = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = "#d9dee8";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = "#121825";
    ctx.fill();
    ctx.restore();
  }

  function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  function createOfflineGame(humanName) {
    const game = {
      version: 1,
      roomCode: "BOT",
      phase: "playing",
      message: "Offline duel started.",
      round: 0,
      target: 21,
      tally: 1,
      saw: 0,
      sawLimit: 7,
      turn: 0,
      deck: freshDeck(),
      players: [createPlayer("human", humanName, 0), createPlayer("bot", "Bot", 1)],
      winnerId: null,
      roundResult: null,
      log: ["Offline bot mode started."],
    };
    startRound(game);
    return game;
  }

  function createPlayer(id, name, slot) {
    return {
      id,
      name,
      slot,
      connected: true,
      hand: [],
      stood: false,
      busted: false,
      guard: 0,
      trumps: [],
      lastTotal: null,
    };
  }

  function runOfflineAction(action) {
    if (!state) return;
    const actorIndex = state.players.findIndex((player) => player.id === you);
    if (action.type === "draw") takeDraw(state, actorIndex);
    else if (action.type === "stand") takeStand(state, actorIndex);
    else if (action.type === "playTrump") playActionCard(state, actorIndex, String(action.cardId || ""));
    else if (action.type === "nextRound") {
      if (state.phase !== "roundOver") throw new Error("The round is not over yet.");
      startRound(state);
    } else if (action.type === "restart") {
      state.round = 0;
      state.saw = 0;
      state.winnerId = null;
      state.log = ["Duel restarted."];
      state.deck = freshDeck();
      startRound(state);
    }
  }

  function maybeBotTurn() {
    clearTimeout(botTimer);
    if (mode !== "offline" || !state || state.phase !== "playing" || state.turn !== 1) return;
    botTimer = setTimeout(() => {
      try {
        runBotDecision();
        render();
        maybeBotTurn();
      } catch (error) {
        lastError = error.message;
        render();
      }
    }, 650);
  }

  function runBotDecision() {
    const botIndex = 1;
    const bot = state.players[botIndex];
    const botTotal = total(bot);
    const usefulCard = chooseBotAction(bot, botTotal);
    if (usefulCard) {
      playActionCard(state, botIndex, usefulCard.id);
      return;
    }

    const target = state.target;
    const safeGap = target - botTotal;
    const pressure = Math.abs(state.saw) >= state.sawLimit - 3 || state.tally >= 4;
    if (safeGap >= (pressure ? 5 : 4)) {
      takeDraw(state, botIndex);
    } else {
      takeStand(state, botIndex);
    }
  }

  function chooseBotAction(bot, botTotal) {
    const available = bot.trumps.filter((card) => !card.used);
    if (botTotal > state.target) {
      return (
        available.find((card) => card.type === "targetUp") ||
        available.find((card) => card.type === "swapHigh") ||
        available.find((card) => card.type === "dropLow")
      );
    }
    if (botTotal >= state.target - 1 && state.tally >= 3) {
      return available.find((card) => card.type === "addTally");
    }
    if (botTotal <= state.target - 6) {
      return available.find((card) => card.type === "targetDown" && state.players[0].stood);
    }
    if (state.tally >= 4 && state.saw > 1) {
      return available.find((card) => card.type === "guard");
    }
    return null;
  }

  function startRound(game) {
    game.round += 1;
    game.target = 21;
    game.tally = Math.min(6, game.round);
    game.phase = "playing";
    game.winnerId = null;
    game.roundResult = null;
    game.turn = (game.round - 1) % 2;

    for (const player of game.players) {
      player.hand = [drawCard(game), drawCard(game)];
      player.stood = false;
      player.busted = false;
      player.guard = 0;
      player.trumps = dealActionCards(2);
      player.lastTotal = null;
    }

    game.message = `Round ${game.round}: get closest to ${game.target}. Saw tally is ${game.tally}.`;
    pushLog(game, `Round ${game.round} began. Tally ${game.tally}.`);
  }

  function freshDeck() {
    const suits = ["♠", "♥", "♦", "♣"];
    const deck = [];
    for (const suit of suits) {
      for (let value = 1; value <= 11; value += 1) {
        deck.push({ id: `${value}${suit}-${randomId()}`, value, suit });
      }
    }
    return shuffle(deck);
  }

  function shuffle(items) {
    const arr = [...items];
    for (let index = arr.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [arr[index], arr[swapIndex]] = [arr[swapIndex], arr[index]];
    }
    return arr;
  }

  function drawCard(game) {
    if (!game.deck || game.deck.length < 8) game.deck = freshDeck();
    return game.deck.pop();
  }

  function dealActionCards(count) {
    return shuffle(ACTION_CARDS)
      .slice(0, count)
      .map((card) => ({ ...card, id: randomId(), used: false }));
  }

  function takeDraw(game, actorIndex) {
    assertPlayableTurn(game, actorIndex);
    const player = game.players[actorIndex];
    const card = drawCard(game);
    player.hand.push(card);
    player.busted = total(player) > game.target;
    if (player.busted) {
      player.stood = true;
      pushLog(game, `${player.name} drew ${card.value} and busted at ${total(player)}.`);
    } else {
      pushLog(game, `${player.name} drew a card.`);
    }
    advanceTurn(game, actorIndex);
  }

  function takeStand(game, actorIndex) {
    assertPlayableTurn(game, actorIndex);
    const player = game.players[actorIndex];
    player.stood = true;
    pushLog(game, `${player.name} stood at ${total(player)}.`);
    advanceTurn(game, actorIndex);
  }

  function playActionCard(game, actorIndex, cardId) {
    assertPlayableTurn(game, actorIndex);
    const player = game.players[actorIndex];
    const card = player.trumps.find((candidate) => candidate.id === cardId && !candidate.used);
    if (!card) throw new Error("That action card is not available.");

    card.used = true;
    if (card.type === "targetUp") {
      game.target = Math.min(27, game.target + 3);
      pushLog(game, `${player.name} raised the target to ${game.target}.`);
    } else if (card.type === "targetDown") {
      game.target = Math.max(16, game.target - 2);
      pushLog(game, `${player.name} lowered the target to ${game.target}.`);
    } else if (card.type === "addTally") {
      game.tally = Math.min(9, game.tally + 1);
      pushLog(game, `${player.name} increased the saw tally to ${game.tally}.`);
    } else if (card.type === "guard") {
      player.guard += 1;
      pushLog(game, `${player.name} braced against the saw.`);
    } else if (card.type === "swapHigh") {
      if (!player.hand.length) throw new Error("No cards to swap.");
      const index = indexOfExtremeCard(player.hand, "high");
      const removed = player.hand.splice(index, 1)[0];
      const fresh = drawCard(game);
      player.hand.push(fresh);
      pushLog(game, `${player.name} replaced a ${removed.value}.`);
    } else if (card.type === "dropLow") {
      if (player.hand.length < 3) throw new Error("Drop Low requires at least 3 cards.");
      const index = indexOfExtremeCard(player.hand, "low");
      const removed = player.hand.splice(index, 1)[0];
      pushLog(game, `${player.name} dropped a ${removed.value}.`);
    }

    refreshBusts(game);
    advanceTurn(game, actorIndex);
  }

  function indexOfExtremeCard(hand, mode) {
    let bestIndex = 0;
    for (let index = 1; index < hand.length; index += 1) {
      if (mode === "high" && hand[index].value > hand[bestIndex].value) bestIndex = index;
      if (mode === "low" && hand[index].value < hand[bestIndex].value) bestIndex = index;
    }
    return bestIndex;
  }

  function assertPlayableTurn(game, actorIndex) {
    if (game.phase !== "playing") throw new Error("The round is not active.");
    if (game.turn !== actorIndex) throw new Error("It is not your turn.");
    const player = game.players[actorIndex];
    if (player.stood || player.busted) throw new Error("You are already locked for this round.");
  }

  function refreshBusts(game) {
    for (const player of game.players) {
      player.busted = total(player) > game.target;
      if (player.busted) player.stood = true;
    }
  }

  function advanceTurn(game, actorIndex) {
    if (game.players.every((player) => player.stood || player.busted)) {
      finishRound(game);
      return;
    }

    const nextIndex = actorIndex === 0 ? 1 : 0;
    if (!game.players[nextIndex].stood && !game.players[nextIndex].busted) {
      game.turn = nextIndex;
    } else if (!game.players[actorIndex].stood && !game.players[actorIndex].busted) {
      game.turn = actorIndex;
    } else {
      finishRound(game);
    }
  }

  function finishRound(game) {
    const scores = game.players.map((player) => ({ total: total(player), distance: scoreDistance(player, game.target) }));
    game.players.forEach((player, index) => {
      player.lastTotal = scores[index].total;
      player.stood = true;
    });

    const tie = scores[0].distance === scores[1].distance;
    game.phase = "roundOver";

    if (tie) {
      game.roundResult = {
        tie: true,
        target: game.target,
        totals: scores.map((score) => score.total),
        move: 0,
        message: "Tie round. The saw holds position.",
      };
      game.message = game.roundResult.message;
      pushLog(game, `Round tied at ${scores[0].total} to ${scores[1].total}.`);
      return;
    }

    const winnerIndex = scores[0].distance < scores[1].distance ? 0 : 1;
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const loser = game.players[loserIndex];
    const blocked = Math.min(loser.guard || 0, game.tally);
    const move = Math.max(0, game.tally - blocked);
    const direction = loserIndex === 0 ? -1 : 1;
    game.saw += direction * move;

    const winner = game.players[winnerIndex];
    game.roundResult = {
      tie: false,
      winnerIndex,
      loserIndex,
      target: game.target,
      totals: scores.map((score) => score.total),
      move,
      blocked,
      message: `${winner.name} wins the round. Saw moves ${move}.`,
    };
    game.message = game.roundResult.message;
    pushLog(game, `${winner.name} won round ${game.round}; ${loser.name} lost ${move} track.`);

    if (Math.abs(game.saw) >= game.sawLimit) {
      game.phase = "gameOver";
      game.winnerId = winner.id;
      game.message = `${winner.name} wins the duel.`;
      pushLog(game, game.message);
    }
  }

  function scoreDistance(player, target) {
    const playerTotal = total(player);
    if (playerTotal > target) return 100 + (playerTotal - target);
    return target - playerTotal;
  }

  function total(player) {
    return player.hand.reduce((sum, card) => sum + card.value, 0);
  }

  function pushLog(game, line) {
    game.log.push(line);
    if (game.log.length > 80) game.log.splice(0, game.log.length - 80);
  }

  function publicStateFor(game, viewerId) {
    const reveal = game.phase === "roundOver" || game.phase === "gameOver";
    return {
      version: game.version,
      roomCode: game.roomCode,
      phase: game.phase,
      message: game.message,
      round: game.round,
      target: game.target,
      tally: game.tally,
      saw: game.saw,
      sawLimit: game.sawLimit,
      turn: game.turn,
      winnerId: game.winnerId,
      roundResult: game.roundResult,
      log: game.log.slice(-20),
      players: game.players.map((player) => {
        const isViewer = player.id === viewerId;
        const canRevealHand = isViewer || reveal;
        return {
          id: player.id,
          name: player.name,
          slot: player.slot,
          connected: player.connected,
          stood: player.stood,
          busted: player.busted,
          guard: player.guard,
          total: canRevealHand ? total(player) : null,
          hand: player.hand.map((card, index) =>
            canRevealHand ? card : { id: `hidden-${player.id}-${index}`, hidden: true },
          ),
          trumps: isViewer ? player.trumps : [],
          trumpCount: player.trumps.filter((card) => !card.used).length,
        };
      }),
    };
  }

  function normalizeRoomCode(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
  }

  function randomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => {
      const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };
      return map[char];
    });
  }
})();
