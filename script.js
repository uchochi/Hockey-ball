/**
 * GALA Game - Glow Hockey (Layer 2)
 * 
 * Features:
 * - postMessage API for Layer 1 communication
 * - 7 AI difficulty tiers (Beginner → The-Expert)
 * - Countdown (timed) + Tournament (first-to-7) modes
 * - Team relay (players rotate per round/goal)
 * - Tips & Tricks 7-second breaks (Real USDT mode only)
 * - Real-time chat with synchronized pause
 * - Secure GAME_OVER handshake with hash token
 */

window.addEventListener("load", function () {

  // ─── DOM Elements ───
  const gameCanvas = document.getElementById("gameCanvas");
  const gameContext = gameCanvas.getContext("2d");

  // ─── Match Blueprint (received from Layer 1 via postMessage) ───
  let matchConfig = {
    isDemoMode: true,
    gameMode: "tournament",       // "tournament" | "countdown"
    winningScore: 7,
    roundDurationSec: 180,        // 3 min per round
    totalRounds: 3,
    teamA: [{ name: "OPPONENT", avatar: "OP", isBot: true, aiDifficulty: 4 }],
    teamB: [{ name: "YOU", avatar: "YO", isBot: false, aiDifficulty: 0 }],
    tips: [
      "Invite & Earn: Create a game request and click 'Share' to invite your friends!",
      "Match Your Skill: Play against players of similar level for better chances.",
      "Tilt Warning: Lost 2+ in a row? Take a break and practice in Demo mode!",
      "Risk Management: Games are for fun, not pain. Never stake more than you can lose.",
      "Reality Check: Don't expect to get rich playing games. Play responsibly.",
      "Grow your Clan: Team up in 5v5 with your Telegram group chats!"
    ],
    secretToken: null,
    matchId: null
  };

  // ─── Game State ───
  const gameState = {
    playerPaddle: { xPosition: 0, yPosition: 0, radius: 30, score: 0 },
    aiPaddle: { xPosition: 0, yPosition: 0, radius: 30, score: 0 },
    gameBall: {
      xPosition: 0, yPosition: 0, radius: 15,
      velocityX: 0, velocityY: 0,
      maxSpeed: 14, minSpeed: 8,
      // Frozen state for pause resume
      frozenX: 0, frozenY: 0, frozenVX: 0, frozenVY: 0
    },
    isGameRunning: false,
    isGameStarted: false,
    isPaused: false,
    isTipsPause: false,
    isChatPause: false,
    lastScorer: null,
    ballGlowEffect: 0,

    // Countdown mode
    currentRound: 1,
    roundTimeRemaining: 180,
    timerInterval: null,

    // Team relay
    currentTeamAPlayer: 0,
    currentTeamBPlayer: 0,
    totalGoalsForRelay: 0,

    // Tips
    tipsShown: [],
    tipsInterval: null,

    // Chat
    chatMessages: [],
    localReady: false,
    remoteReady: false
  };

  // ─── AI Difficulty Profiles (1-7) ───
  // Human-emulating bot. Even when ball is in opponent half, the bot pre-positions
  // along a zigzag path (continuous X+Y micro-drift) anticipating where the ball
  // will return. When the ball approaches, it predicts intercept point ahead of time
  // (not reactively), with prediction noise/lag scaled to difficulty.
  //  - reactionMs: lag before reacting once ball crosses reaction line
  //  - predictionFrames: how far ahead the bot predicts ball trajectory
  //  - reactionLine / strikeLine: y ratios for alert / lunge zones
  //  - trackSpeed / strikeSpeed / driftSpeed: paddle speeds
  //  - aimJitter: px noise on aim point
  //  - missChance: chance to whiff a strike
  //  - feintChance: idle commit-then-cancel rate
  //  - zigzagAmpX/Y: amplitude of anticipatory drift while idling/anticipating
  //  - zigzagFreq: oscillation frequency (Hz). Higher = jitterier human
  //  - homeY: idle row ratio
  const AI_PROFILES = {
    1: { name: "Beginner",            reactionMs: 380, predictionFrames: 8,  reactionLine: 0.42, strikeLine: 0.30, trackSpeed: 3,    strikeSpeed: 5,  retreatSpeed: 2.2, driftSpeed: 1.4, aimJitter: 140, missChance: 0.30, feintChance: 0.04, zigzagAmpX: 0.30, zigzagAmpY: 0.05, zigzagFreq: 0.35, homeY: 0.13 },
    2: { name: "Strong-Beginner",     reactionMs: 300, predictionFrames: 12, reactionLine: 0.45, strikeLine: 0.32, trackSpeed: 4,    strikeSpeed: 6,  retreatSpeed: 2.8, driftSpeed: 1.7, aimJitter: 110, missChance: 0.20, feintChance: 0.05, zigzagAmpX: 0.28, zigzagAmpY: 0.06, zigzagFreq: 0.40, homeY: 0.13 },
    3: { name: "Intermediate",        reactionMs: 230, predictionFrames: 18, reactionLine: 0.48, strikeLine: 0.35, trackSpeed: 5,    strikeSpeed: 7.5,retreatSpeed: 3.4, driftSpeed: 2.0, aimJitter: 80,  missChance: 0.13, feintChance: 0.07, zigzagAmpX: 0.26, zigzagAmpY: 0.07, zigzagFreq: 0.45, homeY: 0.14 },
    4: { name: "Strong-Intermediate", reactionMs: 170, predictionFrames: 25, reactionLine: 0.50, strikeLine: 0.38, trackSpeed: 6,    strikeSpeed: 9,  retreatSpeed: 4,   driftSpeed: 2.4, aimJitter: 55,  missChance: 0.08, feintChance: 0.08, zigzagAmpX: 0.24, zigzagAmpY: 0.08, zigzagFreq: 0.50, homeY: 0.14 },
    5: { name: "Advance",             reactionMs: 120, predictionFrames: 32, reactionLine: 0.52, strikeLine: 0.40, trackSpeed: 7.5,  strikeSpeed: 11, retreatSpeed: 4.6, driftSpeed: 2.8, aimJitter: 32,  missChance: 0.04, feintChance: 0.10, zigzagAmpX: 0.22, zigzagAmpY: 0.09, zigzagFreq: 0.55, homeY: 0.15 },
    6: { name: "Strong-Advance",      reactionMs: 80,  predictionFrames: 42, reactionLine: 0.55, strikeLine: 0.42, trackSpeed: 9,    strikeSpeed: 13, retreatSpeed: 5.2, driftSpeed: 3.2, aimJitter: 18,  missChance: 0.02, feintChance: 0.12, zigzagAmpX: 0.20, zigzagAmpY: 0.10, zigzagFreq: 0.60, homeY: 0.15 },
    7: { name: "The-Expert",          reactionMs: 45,  predictionFrames: 55, reactionLine: 0.58, strikeLine: 0.44, trackSpeed: 11,   strikeSpeed: 15, retreatSpeed: 6,   driftSpeed: 3.6, aimJitter: 8,   missChance: 0.01, feintChance: 0.14, zigzagAmpX: 0.18, zigzagAmpY: 0.11, zigzagFreq: 0.65, homeY: 0.16 }
  };

  // Per-bot persistent AI state (resets each round/serve)
  const aiBotState = {
    alertSinceMs: 0,
    lastDecisionMs: 0,
    feintTargetX: null,
    feintUntilMs: 0,
    chosenAimX: null,
    strikeCommitUntilMs: 0,
    lastBallY: 0,
    // Zigzag drift state (two independent sine phases per axis for non-repetitive motion)
    zigPhaseX1: Math.random() * Math.PI * 2,
    zigPhaseX2: Math.random() * Math.PI * 2,
    zigPhaseY1: Math.random() * Math.PI * 2,
    zigPhaseY2: Math.random() * Math.PI * 2,
    // Anticipated intercept X (where bot pre-positions while ball is on opponent side)
    anticipatedX: null,
    anticipationRefreshMs: 0
  };

  function getCurrentAIDifficulty() {
    const player = matchConfig.teamA[gameState.currentTeamAPlayer];
    if (!player || !player.isBot) return AI_PROFILES[4];
    const level = Math.max(1, Math.min(7, player.aiDifficulty || 4));
    return AI_PROFILES[level];
  }

  // ─── postMessage Communication with Layer 1 ───
  window.addEventListener("message", function (event) {
    const data = event.data;
    if (!data || !data.type) return;

    switch (data.type) {
      case "MATCH_BLUEPRINT":
        applyMatchBlueprint(data.payload);
        break;
      case "CHAT_MESSAGE":
        receiveChatMessage(data.payload);
        break;
      case "REMOTE_READY":
        gameState.remoteReady = true;
        checkBothReady();
        break;
    }
  });

  function sendToLayer1(type, payload) {
    if (window.parent !== window) {
      window.parent.postMessage({ type, payload }, "https://gala.lovable.app");
    }
  }

  function applyMatchBlueprint(bp) {
    if (bp.isDemoMode !== undefined) matchConfig.isDemoMode = bp.isDemoMode;
    if (bp.gameMode) matchConfig.gameMode = bp.gameMode;
    if (bp.winningScore) matchConfig.winningScore = bp.winningScore;
    if (bp.roundDurationSec) matchConfig.roundDurationSec = bp.roundDurationSec;
    if (bp.totalRounds) matchConfig.totalRounds = bp.totalRounds;
    if (bp.teamA) matchConfig.teamA = bp.teamA;
    if (bp.teamB) matchConfig.teamB = bp.teamB;
    if (bp.tips) matchConfig.tips = bp.tips;
    if (bp.secretToken) matchConfig.secretToken = bp.secretToken;
    if (bp.matchId) matchConfig.matchId = bp.matchId;

    // Apply names
    updatePlayerNames();
    // Setup mode
    if (matchConfig.gameMode === "countdown") {
      gameState.roundTimeRemaining = matchConfig.roundDurationSec;
      document.getElementById("timerSection").style.display = "block";
      updateTimerDisplay();
      updateRoundDisplay();
    } else {
      document.getElementById("timerSection").style.display = "none";
    }

    restartGame();
    sendToLayer1("LAYER2_READY", { status: "ready" });
  }

  function updatePlayerNames() {
    const aPlayer = matchConfig.teamA[gameState.currentTeamAPlayer] || matchConfig.teamA[0];
    const bPlayer = matchConfig.teamB[gameState.currentTeamBPlayer] || matchConfig.teamB[0];
    document.getElementById("teamAName").textContent = aPlayer ? aPlayer.name : "OPPONENT";
    document.getElementById("teamBName").textContent = bPlayer ? bPlayer.name : "YOU";
  }

  // ─── Canvas Setup ───
  function resizeGameCanvas() {
    const container = document.querySelector(".game-container");
    gameCanvas.width = container.clientWidth;
    gameCanvas.height = container.clientHeight;
    gameState.playerPaddle.xPosition = gameCanvas.width / 2;
    gameState.playerPaddle.yPosition = gameCanvas.height * 0.85;
    gameState.aiPaddle.xPosition = gameCanvas.width / 2;
    gameState.aiPaddle.yPosition = gameCanvas.height * 0.15;
    resetBallPosition();
  }

  function resetBallPosition() {
    gameState.gameBall.xPosition = gameCanvas.width / 2;
    gameState.gameBall.yPosition = gameCanvas.height / 2;
    gameState.gameBall.velocityX = 0;
    gameState.gameBall.velocityY = 0;
    gameState.ballGlowEffect = 0;
  }

  resizeGameCanvas();
  window.addEventListener("resize", resizeGameCanvas);

  // ─── Ball Control ───
  function resetBall(nextServer = null) {
    resetBallPosition();
    gameState.isGameRunning = false;
    const el = document.getElementById("gameStatus");
    el.style.color = "#ff0066";
    el.style.borderColor = "#ff0066";
    el.style.boxShadow = "0 0 25px rgba(255, 0, 102, 0.3)";
    el.classList.remove("ai-serve");

    if (nextServer === "player") {
      el.textContent = "Touch the ball to serve!";
      el.style.display = "block";
      el.style.top = "70%";
    } else if (nextServer === "ai") {
      el.textContent = "Computer serves next...";
      el.style.display = "block";
      el.style.top = "30%";
      el.style.color = "#00ff66";
      el.style.borderColor = "#00ff66";
      el.style.boxShadow = "0 0 25px rgba(0, 255, 102, 0.3)";
      el.classList.add("ai-serve");
      setTimeout(() => {
        if (!gameState.isGameRunning && !gameState.isPaused) {
          startBallMovement("ai");
        }
      }, 1500);
    } else {
      el.textContent = "Touch the ball to start!";
      el.style.display = "block";
    }
  }

  function startBallMovement(server) {
    const angle = (Math.random() - 0.5) * Math.PI / 4;
    const speed = gameState.gameBall.minSpeed;
    if (server === "player") {
      gameState.gameBall.velocityX = Math.sin(angle) * speed;
      gameState.gameBall.velocityY = -Math.cos(angle) * speed;
    } else {
      gameState.gameBall.velocityX = Math.sin(angle) * speed;
      gameState.gameBall.velocityY = Math.cos(angle) * speed;
    }
    gameState.isGameRunning = true;
    gameState.isGameStarted = true;
    document.getElementById("gameStatus").style.display = "none";

    // Start countdown timer if needed
    if (matchConfig.gameMode === "countdown" && !gameState.timerInterval) {
      startCountdownTimer();
    }
  }

  // ─── Countdown Timer ───
  function startCountdownTimer() {
    if (gameState.timerInterval) clearInterval(gameState.timerInterval);
    gameState.timerInterval = setInterval(() => {
      if (gameState.isPaused || gameState.isTipsPause || gameState.isChatPause) return;
      gameState.roundTimeRemaining--;
      updateTimerDisplay();
      if (gameState.roundTimeRemaining <= 0) {
        clearInterval(gameState.timerInterval);
        gameState.timerInterval = null;
        onRoundEnd();
      }
    }, 1000);
  }

  function updateTimerDisplay() {
    const m = Math.floor(gameState.roundTimeRemaining / 60);
    const s = gameState.roundTimeRemaining % 60;
    document.getElementById("gameTimer").textContent =
      String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function updateRoundDisplay() {
    document.getElementById("roundInfo").textContent =
      `Round ${gameState.currentRound} of ${matchConfig.totalRounds}`;
  }

  function onRoundEnd() {
    gameState.isGameRunning = false;

    // Check if final round
    if (gameState.currentRound >= matchConfig.totalRounds) {
      const winner = gameState.playerPaddle.score > gameState.aiPaddle.score
        ? matchConfig.teamB[0]?.name || "You"
        : gameState.playerPaddle.score < gameState.aiPaddle.score
          ? matchConfig.teamA[0]?.name || "Opponent"
          : "Draw";
      endGame(winner === "Draw" ? "It's a Draw!" : `${winner} Wins!`);
      return;
    }

    // Tips break between rounds (Real USDT only)
    if (!matchConfig.isDemoMode && matchConfig.tips.length > 0) {
      showTipsBreak(() => {
        advanceRound();
      });
    } else {
      advanceRound();
    }
  }

  function advanceRound() {
    gameState.currentRound++;
    gameState.roundTimeRemaining = matchConfig.roundDurationSec;
    updateRoundDisplay();
    updateTimerDisplay();

    // Relay: rotate players
    rotateTeamPlayers();
    updatePlayerNames();

    showCountdownFlash(() => {
      resetBall("player");
    });
  }

  // ─── Team Relay Rotation ───
  function rotateTeamPlayers() {
    if (matchConfig.teamA.length > 1) {
      gameState.currentTeamAPlayer = (gameState.currentTeamAPlayer + 1) % matchConfig.teamA.length;
    }
    if (matchConfig.teamB.length > 1) {
      gameState.currentTeamBPlayer = (gameState.currentTeamBPlayer + 1) % matchConfig.teamB.length;
    }
  }

  // ─── Tips & Tricks (7-second break, Real USDT only) ───
  function showTipsBreak(callback) {
    gameState.isTipsPause = true;
    const overlay = document.getElementById("tipsOverlay");
    const textEl = document.getElementById("tipsText");
    const bar = document.getElementById("tipsProgressBar");
    const timerEl = document.getElementById("tipsTimer");

    // Pick random tip not recently shown
    const available = matchConfig.tips.filter((_, i) => !gameState.tipsShown.includes(i));
    let idx;
    if (available.length === 0) {
      gameState.tipsShown = [];
      idx = Math.floor(Math.random() * matchConfig.tips.length);
    } else {
      const origIdx = matchConfig.tips.indexOf(available[Math.floor(Math.random() * available.length)]);
      idx = origIdx;
    }
    gameState.tipsShown.push(idx);
    textEl.textContent = matchConfig.tips[idx];

    bar.style.transition = "none";
    bar.style.width = "100%";
    overlay.classList.add("active");

    let remaining = 7;
    timerEl.textContent = remaining;

    setTimeout(() => {
      bar.style.transition = "width 7s linear";
      bar.style.width = "0%";
    }, 50);

    const interval = setInterval(() => {
      remaining--;
      timerEl.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(interval);
        overlay.classList.remove("active");
        gameState.isTipsPause = false;
        if (callback) callback();
      }
    }, 1000);
  }

  // ─── 3-2-1 Countdown Flash ───
  function showCountdownFlash(callback) {
    let el = document.querySelector(".countdown-flash");
    if (!el) {
      el = document.createElement("div");
      el.className = "countdown-flash";
      document.body.appendChild(el);
    }
    let count = 3;
    function tick() {
      if (count === 0) {
        el.textContent = "GO!";
        el.classList.add("active");
        setTimeout(() => {
          el.classList.remove("active");
          if (callback) callback();
        }, 600);
        return;
      }
      el.textContent = count;
      el.classList.remove("active");
      void el.offsetWidth; // reflow
      el.classList.add("active");
      count--;
      setTimeout(tick, 800);
    }
    tick();
  }

  // ─── Chat / Pause System ───
  document.getElementById("chatSend").addEventListener("click", sendChatMessage);
  document.getElementById("chatInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendChatMessage();
  });
  document.getElementById("chatReady").addEventListener("click", () => {
    gameState.localReady = true;
    sendToLayer1("PLAYER_READY", {});
    // In single-player (vs bot), auto-resume
    const opponent = matchConfig.teamA[gameState.currentTeamAPlayer];
    if (opponent && opponent.isBot) {
      gameState.remoteReady = true;
    }
    checkBothReady();
  });
  document.getElementById("chatClose").addEventListener("click", () => {
    // Same as ready
    document.getElementById("chatReady").click();
  });

  function openChat(pausedByName) {
    gameState.isChatPause = true;
    freezeBall();
    document.getElementById("chatPausedBy").textContent = `Game Paused by ${pausedByName}`;
    document.getElementById("chatOverlay").classList.add("active");
    gameState.localReady = false;
    gameState.remoteReady = false;
  }

  function sendChatMessage() {
    const input = document.getElementById("chatInput");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    addChatBubble(text, true);
    sendToLayer1("CHAT_MESSAGE", { text, from: "player" });
  }

  function receiveChatMessage(payload) {
    addChatBubble(payload.text, false);
  }

  function addChatBubble(text, isSelf) {
    const container = document.getElementById("chatMessages");
    const div = document.createElement("div");
    div.className = `chat-msg ${isSelf ? "self" : "other"}`;
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function checkBothReady() {
    if (gameState.localReady && gameState.remoteReady) {
      document.getElementById("chatOverlay").classList.remove("active");
      gameState.isChatPause = false;
      showCountdownFlash(() => {
        unfreezeBall();
      });
    }
  }

  function freezeBall() {
    const b = gameState.gameBall;
    b.frozenX = b.xPosition;
    b.frozenY = b.yPosition;
    b.frozenVX = b.velocityX;
    b.frozenVY = b.velocityY;
    b.velocityX = 0;
    b.velocityY = 0;
    gameState.isGameRunning = false;
  }

  function unfreezeBall() {
    const b = gameState.gameBall;
    b.xPosition = b.frozenX;
    b.yPosition = b.frozenY;
    b.velocityX = b.frozenVX;
    b.velocityY = b.frozenVY;
    gameState.isGameRunning = true;
  }

  // ─── Drawing ───
  function drawGameField() {
    gameContext.fillStyle = "#000000";
    gameContext.fillRect(0, 0, gameCanvas.width, gameCanvas.height);

    const grad = gameContext.createLinearGradient(0, 0, gameCanvas.width, 0);
    grad.addColorStop(0, "#4CC2A7");
    grad.addColorStop(0.5, "#000000");
    grad.addColorStop(1, "#6B45DB");
    gameContext.strokeStyle = grad;
    gameContext.lineWidth = 8;
    gameContext.strokeRect(0, 0, gameCanvas.width, gameCanvas.height);

    gameContext.strokeStyle = "#AAAAAA";
    gameContext.lineWidth = 4;
    gameContext.setLineDash([15, 15]);
    gameContext.beginPath();
    gameContext.moveTo(20, gameCanvas.height / 2);
    gameContext.lineTo(gameCanvas.width - 20, gameCanvas.height / 2);
    gameContext.stroke();
    gameContext.setLineDash([]);

    gameContext.beginPath();
    gameContext.arc(gameCanvas.width / 2, gameCanvas.height / 2, 60, 0, Math.PI * 2);
    gameContext.stroke();

    const goalW = gameCanvas.width * 0.5;
    const goalX = (gameCanvas.width - goalW) / 2;

    gameContext.strokeStyle = "#00ff66";
    gameContext.lineWidth = 7;
    gameContext.strokeRect(goalX, 0, goalW, 25);
    gameContext.fillStyle = "rgba(0, 255, 102, 0.1)";
    gameContext.fillRect(goalX, 0, goalW, 25);

    gameContext.strokeStyle = "#ff0066";
    gameContext.strokeRect(goalX, gameCanvas.height - 25, goalW, 25);
    gameContext.fillStyle = "rgba(255, 0, 102, 0.1)";
    gameContext.fillRect(goalX, gameCanvas.height - 25, goalW, 25);
  }

  function drawPaddle(paddle, color) {
    gameContext.shadowColor = color;
    gameContext.shadowBlur = 20;
    gameContext.fillStyle = color;
    gameContext.beginPath();
    gameContext.arc(paddle.xPosition, paddle.yPosition, paddle.radius, 0, Math.PI * 2);
    gameContext.fill();

    gameContext.strokeStyle = "#FFFFFF";
    gameContext.lineWidth = 6;
    gameContext.beginPath();
    gameContext.arc(paddle.xPosition, paddle.yPosition, paddle.radius - 8, 0, Math.PI * 2);
    gameContext.stroke();

    gameContext.fillStyle = "#000000";
    gameContext.beginPath();
    gameContext.arc(paddle.xPosition, paddle.yPosition, 7, 0, Math.PI * 2);
    gameContext.fill();
    gameContext.shadowBlur = 0;
  }

  function drawBall() {
    gameState.ballGlowEffect += 0.1;
    const glow = Math.sin(gameState.ballGlowEffect) * 10 + 15;
    gameContext.shadowColor = "#ffff00";
    gameContext.shadowBlur = glow;
    gameContext.fillStyle = "#ffff00";
    gameContext.beginPath();
    gameContext.arc(gameState.gameBall.xPosition, gameState.gameBall.yPosition, gameState.gameBall.radius, 0, Math.PI * 2);
    gameContext.fill();
    gameContext.strokeStyle = "#ffaa00";
    gameContext.lineWidth = 3;
    gameContext.stroke();
    gameContext.fillStyle = "#ffffff";
    gameContext.beginPath();
    gameContext.arc(gameState.gameBall.xPosition - 4, gameState.gameBall.yPosition - 4, 4, 0, Math.PI * 2);
    gameContext.fill();
    gameContext.shadowBlur = 0;
  }

  // ─── Physics ───
  function updateBallPosition() {
    if (!gameState.isGameRunning || gameState.isPaused) return;

    gameState.gameBall.xPosition += gameState.gameBall.velocityX;
    gameState.gameBall.yPosition += gameState.gameBall.velocityY;

    // Side walls
    if (gameState.gameBall.xPosition <= gameState.gameBall.radius ||
      gameState.gameBall.xPosition >= gameCanvas.width - gameState.gameBall.radius) {
      gameState.gameBall.velocityX *= -0.9;
      gameState.gameBall.xPosition = Math.max(gameState.gameBall.radius,
        Math.min(gameCanvas.width - gameState.gameBall.radius, gameState.gameBall.xPosition));
    }

    const goalW = gameCanvas.width * 0.5;
    const goalX = (gameCanvas.width - goalW) / 2;

    // Top goal (player scores)
    if (gameState.gameBall.yPosition <= gameState.gameBall.radius) {
      if (gameState.gameBall.xPosition >= goalX && gameState.gameBall.xPosition <= goalX + goalW) {
        gameState.playerPaddle.score++;
        gameState.lastScorer = "player";
        updateScoreDisplay();
        onGoalScored("player");
        return;
      }
      gameState.gameBall.velocityY *= -0.9;
      gameState.gameBall.yPosition = gameState.gameBall.radius;
    }

    // Bottom goal (AI scores)
    if (gameState.gameBall.yPosition >= gameCanvas.height - gameState.gameBall.radius) {
      if (gameState.gameBall.xPosition >= goalX && gameState.gameBall.xPosition <= goalX + goalW) {
        gameState.aiPaddle.score++;
        gameState.lastScorer = "ai";
        updateScoreDisplay();
        onGoalScored("ai");
        return;
      }
      gameState.gameBall.velocityY *= -0.9;
      gameState.gameBall.yPosition = gameCanvas.height - gameState.gameBall.radius;
    }
  }

  function onGoalScored(scorer) {
    gameState.totalGoalsForRelay++;

    // Tournament mode: check winning score
    if (matchConfig.gameMode === "tournament") {
      if (gameState.playerPaddle.score >= matchConfig.winningScore) {
        endGame(`${matchConfig.teamB[0]?.name || "You"} Win!`);
        return;
      }
      if (gameState.aiPaddle.score >= matchConfig.winningScore) {
        endGame(`${matchConfig.teamA[0]?.name || "Opponent"} Wins!`);
        return;
      }

      // Tournament relay: rotate on every goal
      if (matchConfig.teamA.length > 1 || matchConfig.teamB.length > 1) {
        rotateTeamPlayers();
        updatePlayerNames();
      }

      // Tips break after goal (Real USDT only, tournament mode)
      if (!matchConfig.isDemoMode && matchConfig.tips.length > 0) {
        showTipsBreak(() => {
          resetBall(scorer === "player" ? "ai" : "player");
        });
      } else {
        resetBall(scorer === "player" ? "ai" : "player");
      }
    } else {
      // Countdown mode: just reset ball, no win check per goal
      resetBall(scorer === "player" ? "ai" : "player");
    }
  }

  function checkPaddleCollision(paddle) {
    const b = gameState.gameBall;
    const dx = b.xPosition - paddle.xPosition;
    const dy = b.yPosition - paddle.yPosition;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = b.radius + paddle.radius;

    if (dist < minDist) {
      const angle = Math.atan2(dy, dx);
      const speed = Math.sqrt(b.velocityX * b.velocityX + b.velocityY * b.velocityY);
      const newSpeed = Math.min(b.maxSpeed, Math.max(b.minSpeed, speed * 1.05));

      b.velocityX = Math.cos(angle) * newSpeed;
      b.velocityY = Math.sin(angle) * newSpeed;

      const overlap = minDist - dist;
      b.xPosition += Math.cos(angle) * overlap;
      b.yPosition += Math.sin(angle) * overlap;
    }
  }

  // ─── AI: Reactive Striker (human-emulating) ───
  // The bot lives near its goal. As the ball approaches, it "wakes up" after a
  // reaction delay, slides to intercept with some aim noise, then LUNGES forward
  // to strike (mimicking a human swinging the paddle). When the ball is in the
  // opponent's half it returns to a home position with occasional small feints.
  function updateAIPaddle() {
    if (!gameState.isGameRunning || gameState.isPaused) return;

    const ai = gameState.aiPaddle;
    const ball = gameState.gameBall;
    const diff = getCurrentAIDifficulty();
    const now = performance.now();
    const H = gameCanvas.height;
    const W = gameCanvas.width;

    const ballInOurHalf = ball.yPosition < H / 2;
    const ballApproaching = ball.velocityY < 0;
    const reactionLineY = H * diff.reactionLine;
    const strikeLineY = H * diff.strikeLine;
    const homeY = H * diff.homeY + ai.radius + 6;

    // ── Continuous zigzag drift (humans never sit perfectly still) ──
    // Two superposed sines with slightly different frequencies → non-repeating
    // x and y move on independent zigzag offsets, scaled by amplitude.
    const t = now / 1000;
    const f = diff.zigzagFreq;
    aiBotState.zigPhaseX1 += 0.0001; // tiny phase drift to avoid lockstep
    const zigOffsetX = (
      Math.sin(t * Math.PI * 2 * f + aiBotState.zigPhaseX1) * 0.6 +
      Math.sin(t * Math.PI * 2 * f * 1.7 + aiBotState.zigPhaseX2) * 0.4
    ) * (W * diff.zigzagAmpX);
    const zigOffsetY = (
      Math.sin(t * Math.PI * 2 * f * 0.8 + aiBotState.zigPhaseY1) * 0.6 +
      Math.sin(t * Math.PI * 2 * f * 1.3 + aiBotState.zigPhaseY2) * 0.4
    ) * (H * diff.zigzagAmpY);

    // 1) Reaction-line clock (when ball crosses into our half approaching us)
    if (ballApproaching && ball.yPosition < reactionLineY) {
      if (aiBotState.alertSinceMs === 0) aiBotState.alertSinceMs = now;
    } else {
      aiBotState.alertSinceMs = 0;
      aiBotState.chosenAimX = null;
      aiBotState.strikeCommitUntilMs = 0;
    }
    const reactionElapsed = aiBotState.alertSinceMs ? now - aiBotState.alertSinceMs : 0;
    const reacting = aiBotState.alertSinceMs > 0 && reactionElapsed >= diff.reactionMs;

    // ── Ahead-of-time anticipation: predict where the ball will be when it returns
    // to our half, refresh every ~600ms so we're not chasing every frame.
    if (!ballInOurHalf || !ballApproaching) {
      if (now - aiBotState.anticipationRefreshMs > 600) {
        aiBotState.anticipationRefreshMs = now;
        // Project ball forward `predictionFrames` frames and use that x as anchor
        let px = ball.xPosition + ball.velocityX * diff.predictionFrames;
        let py = ball.yPosition + ball.velocityY * diff.predictionFrames;
        // Reflect off side walls
        while (px < ai.radius || px > W - ai.radius) {
          if (px < ai.radius) px = 2 * ai.radius - px;
          else if (px > W - ai.radius) px = 2 * (W - ai.radius) - px;
        }
        // Reflect off bottom wall (ball coming back up)
        if (py > H - ai.radius) py = 2 * (H - ai.radius) - py;
        // Add prediction noise scaled to aim jitter
        aiBotState.anticipatedX = px + (Math.random() - 0.5) * diff.aimJitter * 1.5;
      }
    } else if (reacting) {
      aiBotState.anticipationRefreshMs = 0; // force fresh anticipation after rally
    }

    // 2) Decide intent
    let targetX = ai.xPosition;
    let targetY = homeY;
    let speedX = diff.trackSpeed;
    let speedY = diff.retreatSpeed;

    if (reacting && ballApproaching) {
      // Active intercept — predict landing X with one wall bounce
      const interceptY = Math.max(strikeLineY, ai.yPosition);
      const dy = ball.yPosition - interceptY;
      const vy = Math.abs(ball.velocityY) || 1;
      const tFrames = Math.max(1, dy / vy);
      let predX = ball.xPosition + ball.velocityX * tFrames;
      while (predX < ai.radius || predX > W - ai.radius) {
        if (predX < ai.radius) predX = 2 * ai.radius - predX;
        else if (predX > W - ai.radius) predX = 2 * (W - ai.radius) - predX;
      }

      // Pick aim point on opponent goal (once per approach)
      if (aiBotState.chosenAimX === null) {
        const goalW = W * 0.5;
        const goalLeft = (W - goalW) / 2 + 30;
        const goalRight = goalLeft + goalW - 60;
        const human = gameState.playerPaddle.xPosition;
        aiBotState.chosenAimX = (human < W / 2)
          ? goalRight - Math.random() * (goalW * 0.25)
          : goalLeft + Math.random() * (goalW * 0.25);
      }

      const jitter = (Math.random() - 0.5) * diff.aimJitter;
      const aimBias = (predX - aiBotState.chosenAimX) * 0.15;
      targetX = predX + aimBias + jitter;
      targetY = strikeLineY + ai.radius * 0.5; // press forward toward strike line

      if (ball.yPosition < strikeLineY + ai.radius * 2) {
        if (Math.random() < diff.missChance && aiBotState.strikeCommitUntilMs === 0) {
          targetY = ai.yPosition + 4;
          speedY = diff.trackSpeed * 0.5;
        } else {
          aiBotState.strikeCommitUntilMs = Math.max(aiBotState.strikeCommitUntilMs, now + 220);
        }
      }
      speedX = diff.strikeSpeed;
      speedY = Math.max(speedY, diff.strikeSpeed * 0.7);
    } else if (!ballInOurHalf) {
      // ── Ball on opponent side: pre-position around anticipated intercept,
      //    layered with continuous zigzag so the bot never just "parks". ──
      const anchor = aiBotState.anticipatedX !== null ? aiBotState.anticipatedX : W / 2;
      // Idle feint commitments (occasional larger lateral fakes)
      if (now > aiBotState.feintUntilMs) {
        if (Math.random() < diff.feintChance / 60) {
          aiBotState.feintTargetX = anchor + (Math.random() - 0.5) * (W * 0.30);
          aiBotState.feintUntilMs = now + 400 + Math.random() * 500;
        } else {
          aiBotState.feintTargetX = null;
        }
      }
      const baseX = aiBotState.feintTargetX !== null ? aiBotState.feintTargetX : anchor;
      targetX = baseX + zigOffsetX;
      targetY = homeY + zigOffsetY;
      speedX = diff.driftSpeed;
      speedY = diff.driftSpeed * 0.85;
    } else {
      // Ball in our half but reaction lag still pending — drift toward predicted x
      const anchor = aiBotState.anticipatedX !== null ? aiBotState.anticipatedX : ball.xPosition;
      targetX = anchor + zigOffsetX * 0.5;
      targetY = homeY + zigOffsetY * 0.5;
      speedX = diff.trackSpeed * 0.7;
    }

    // 3) Lunge commitment
    if (now < aiBotState.strikeCommitUntilMs) {
      targetY = Math.min(H / 2 - ai.radius - 8, ai.yPosition + ai.radius * 1.4);
      speedY = diff.strikeSpeed;
      speedX = diff.strikeSpeed;
    }

    // 4) Move toward target with capped speed
    const dx = targetX - ai.xPosition;
    if (Math.abs(dx) > 1) {
      ai.xPosition += Math.sign(dx) * Math.min(speedX, Math.abs(dx));
    }
    const dyMove = targetY - ai.yPosition;
    if (Math.abs(dyMove) > 0.8) {
      ai.yPosition += Math.sign(dyMove) * Math.min(speedY, Math.abs(dyMove));
    }

    // 5) Clamp inside bot's half
    ai.xPosition = Math.max(ai.radius, Math.min(W - ai.radius, ai.xPosition));
    ai.yPosition = Math.max(ai.radius + 18, Math.min(H / 2 - ai.radius - 8, ai.yPosition));

    aiBotState.lastBallY = ball.yPosition;
  }

  // ─── Input ───
  function handleUserInput(x, y) {
    if (!gameState.isGameRunning && !gameState.isPaused && !gameState.isTipsPause && !gameState.isChatPause) {
      const dx = x - gameState.gameBall.xPosition;
      const dy = y - gameState.gameBall.yPosition;
      if (Math.sqrt(dx * dx + dy * dy) < gameState.gameBall.radius + 30) {
        startBallMovement("player");
        return;
      }
    }
    if (y > gameCanvas.height / 2 && !gameState.isPaused && !gameState.isTipsPause && !gameState.isChatPause) {
      gameState.playerPaddle.xPosition = Math.max(
        gameState.playerPaddle.radius,
        Math.min(gameCanvas.width - gameState.playerPaddle.radius, x)
      );
      gameState.playerPaddle.yPosition = Math.max(
        gameCanvas.height / 2 + 60,
        Math.min(gameCanvas.height - gameState.playerPaddle.radius - 30, y)
      );
    }
  }

  gameCanvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    const r = gameCanvas.getBoundingClientRect();
    const t = e.touches[0];
    handleUserInput(
      (t.clientX - r.left) * (gameCanvas.width / r.width),
      (t.clientY - r.top) * (gameCanvas.height / r.height)
    );
  });
  gameCanvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const r = gameCanvas.getBoundingClientRect();
    const t = e.touches[0];
    handleUserInput(
      (t.clientX - r.left) * (gameCanvas.width / r.width),
      (t.clientY - r.top) * (gameCanvas.height / r.height)
    );
  });
  gameCanvas.addEventListener("mousedown", (e) => {
    const r = gameCanvas.getBoundingClientRect();
    handleUserInput(
      (e.clientX - r.left) * (gameCanvas.width / r.width),
      (e.clientY - r.top) * (gameCanvas.height / r.height)
    );
  });
  gameCanvas.addEventListener("mousemove", (e) => {
    const r = gameCanvas.getBoundingClientRect();
    const y = (e.clientY - r.top) * (gameCanvas.height / r.height);
    if (y > gameCanvas.height / 2) {
      handleUserInput(
        (e.clientX - r.left) * (gameCanvas.width / r.width), y
      );
    }
  });

  // ─── Score / End ───
  function updateScoreDisplay() {
    document.getElementById("playerScore").textContent = gameState.playerPaddle.score;
    document.getElementById("aiScore").textContent = gameState.aiPaddle.score;
  }

  function endGame(winnerText) {
    gameState.isGameRunning = false;
    if (gameState.timerInterval) {
      clearInterval(gameState.timerInterval);
      gameState.timerInterval = null;
    }
    document.getElementById("winnerText").textContent = winnerText;
    document.getElementById("finalScore").textContent =
      `${matchConfig.teamA[0]?.name || "Opponent"} ${gameState.aiPaddle.score} - ${gameState.playerPaddle.score} ${matchConfig.teamB[0]?.name || "You"}`;
    document.getElementById("gameOver").style.display = "flex";

    // Send GAME_OVER to Layer 1
    const result = {
      matchId: matchConfig.matchId,
      winnerTeam: gameState.playerPaddle.score > gameState.aiPaddle.score ? "B" : "A",
      scoreA: gameState.aiPaddle.score,
      scoreB: gameState.playerPaddle.score,
      timestamp: Date.now()
    };

    // Simple hash using secret token (in production, use proper HMAC)
    if (matchConfig.secretToken) {
      result.hash = simpleHash(matchConfig.secretToken + JSON.stringify({
        matchId: result.matchId,
        winnerTeam: result.winnerTeam,
        scoreA: result.scoreA,
        scoreB: result.scoreB
      }));
    }

    sendToLayer1("GAME_OVER", result);
  }

  // Simple hash for demo (production should use crypto.subtle HMAC)
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  function restartGame() {
    gameState.playerPaddle.score = 0;
    gameState.aiPaddle.score = 0;
    gameState.playerPaddle.xPosition = gameCanvas.width / 2;
    gameState.playerPaddle.yPosition = gameCanvas.height * 0.85;
    gameState.aiPaddle.xPosition = gameCanvas.width / 2;
    gameState.aiPaddle.yPosition = gameCanvas.height * 0.15;
    gameState.isGameStarted = false;
    gameState.isPaused = false;
    gameState.isTipsPause = false;
    gameState.isChatPause = false;
    gameState.lastScorer = null;
    gameState.currentRound = 1;
    gameState.roundTimeRemaining = matchConfig.roundDurationSec;
    gameState.currentTeamAPlayer = 0;
    gameState.currentTeamBPlayer = 0;
    gameState.totalGoalsForRelay = 0;
    gameState.tipsShown = [];
    if (gameState.timerInterval) {
      clearInterval(gameState.timerInterval);
      gameState.timerInterval = null;
    }
    if (matchConfig.gameMode === "countdown") {
      updateTimerDisplay();
      updateRoundDisplay();
    }
    resetBall();
    updateScoreDisplay();
    updatePlayerNames();
    document.getElementById("gameOver").style.display = "none";
    document.getElementById("pause-btn").textContent = "Pause";
  }

  function togglePause() {
    if (gameState.isTipsPause || gameState.isChatPause) return;
    gameState.isPaused = !gameState.isPaused;
    const btn = document.getElementById("pause-btn");
    if (gameState.isPaused) {
      btn.textContent = "Resume";
      // Open chat overlay for multiplayer pause
      const currentPlayer = matchConfig.teamB[gameState.currentTeamBPlayer] || { name: "You" };
      openChat(currentPlayer.name);
    } else {
      btn.textContent = "Pause";
      document.getElementById("chatOverlay").classList.remove("active");
      gameState.isChatPause = false;
    }
  }

  // ─── Game Loop ───
  function gameLoop() {
    if (!gameState.isPaused && !gameState.isTipsPause && !gameState.isChatPause) {
      updateBallPosition();
      updateAIPaddle();
      checkPaddleCollision(gameState.playerPaddle);
      checkPaddleCollision(gameState.aiPaddle);
    }
    gameContext.clearRect(0, 0, gameCanvas.width, gameCanvas.height);
    drawGameField();
    drawPaddle(gameState.playerPaddle, "#ff0066");
    drawPaddle(gameState.aiPaddle, "#00ff66");
    drawBall();
    requestAnimationFrame(gameLoop);
  }

  // ─── Button Events ───
  document.getElementById("pause-btn").addEventListener("click", () => {
    if (gameState.isGameStarted) togglePause();
  });
  document.getElementById("restart-btn").addEventListener("click", restartGame);
  document.getElementById("restart-game").addEventListener("click", restartGame);

  // ─── Init ───
  updatePlayerNames();
  updateScoreDisplay();
  resetBall();
  gameLoop();

  // Notify Layer 1 that Layer 2 is loaded
  sendToLayer1("LAYER2_LOADED", { status: "loaded" });
});
