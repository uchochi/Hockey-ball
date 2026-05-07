/**
 * Burkwin - Glow Hockey (Layer 2)
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
  // Human-emulating reactive striker model.
  //  - reactionMs: how slowly the bot starts moving once ball enters its half (lag)
  //  - reactionLine: y ratio (0..1). When ball.y < this, bot becomes "alert" and tracks aggressively
  //  - strikeLine: y ratio. When ball crosses this, bot lunges forward to strike
  //  - trackSpeed / strikeSpeed: paddle px/frame in tracking vs striking modes
  //  - aimJitter: random px noise added to predicted target (lower = more accurate)
  //  - missChance: chance per "should-strike" that bot fakes the strike (whiff)
  //  - feintChance: chance per second of doing a small idle feint when ball is far
  //  - homeY ratio: where bot returns to when ball is in opponent half
  const AI_PROFILES = {
    1: { name: "Beginner",            reactionMs: 380, reactionLine: 0.42, strikeLine: 0.30, trackSpeed: 3,    strikeSpeed: 5,  retreatSpeed: 2.2, aimJitter: 140, missChance: 0.30, feintChance: 0.04, homeY: 0.13 },
    2: { name: "Strong-Beginner",     reactionMs: 300, reactionLine: 0.45, strikeLine: 0.32, trackSpeed: 4,    strikeSpeed: 6,  retreatSpeed: 2.8, aimJitter: 110, missChance: 0.20, feintChance: 0.05, homeY: 0.13 },
    3: { name: "Intermediate",        reactionMs: 230, reactionLine: 0.48, strikeLine: 0.35, trackSpeed: 5,    strikeSpeed: 7.5,retreatSpeed: 3.4, aimJitter: 80,  missChance: 0.13, feintChance: 0.07, homeY: 0.14 },
    4: { name: "Strong-Intermediate", reactionMs: 170, reactionLine: 0.50, strikeLine: 0.38, trackSpeed: 6,    strikeSpeed: 9,  retreatSpeed: 4,   aimJitter: 55,  missChance: 0.08, feintChance: 0.08, homeY: 0.14 },
    5: { name: "Advance",             reactionMs: 120, reactionLine: 0.52, strikeLine: 0.40, trackSpeed: 7.5,  strikeSpeed: 11, retreatSpeed: 4.6, aimJitter: 32,  missChance: 0.04, feintChance: 0.10, homeY: 0.15 },
    6: { name: "Strong-Advance",      reactionMs: 80,  reactionLine: 0.55, strikeLine: 0.42, trackSpeed: 9,    strikeSpeed: 13, retreatSpeed: 5.2, aimJitter: 18,  missChance: 0.02, feintChance: 0.12, homeY: 0.15 },
    7: { name: "The-Expert",          reactionMs: 45,  reactionLine: 0.58, strikeLine: 0.44, trackSpeed: 11,   strikeSpeed: 15, retreatSpeed: 6,   aimJitter: 8,   missChance: 0.01, feintChance: 0.14, homeY: 0.16 }
  };

  // Per-bot persistent AI state (resets each round/serve)
  const aiBotState = {
    alertSinceMs: 0,        // wall-clock when ball first crossed reaction line
    lastDecisionMs: 0,
    feintTargetX: null,     // small offset target for idle feints
    feintUntilMs: 0,
    chosenAimX: null,       // target x on player goal we're aiming for in current strike
    strikeCommitUntilMs: 0, // we keep committing to a lunge until this time
    lastBallY: 0
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
      window.parent.postMessage({ type, payload }, "*");
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
    gameContext.arc(gameState.gameBall.xPosition, gameState
