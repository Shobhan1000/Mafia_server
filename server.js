const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: "*",
    methods: ["GET", "POST"]
  } 
});

const games = {};
const ROLE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Role configuration with emojis (can be replaced with image URLs)
const ROLE_CONFIG = {
  Mafia: {
    emoji: "🕶️",
    color: "#DC143C",
    description: "You work with other Mafia members to eliminate villagers at night.",
    nightAction: "Choose a victim to kill",
    winCondition: "Mafia win when they equal or outnumber villagers."
  },
  Detective: {
    emoji: "🕵️",
    color: "#4169E1",
    description: "Each night, you can investigate one player to learn their allegiance.",
    nightAction: "Investigate a player",
    winCondition: "Villagers win when all Mafia are eliminated."
  },
  Doctor: {
    emoji: "⚕️",
    color: "#32CD32",
    description: "Each night, you can save one player from being killed by the Mafia.",
    nightAction: "Protect a player",
    winCondition: "Villagers win when all Mafia are eliminated."
  },
  Villager: {
    emoji: "👨‍🌾",
    color: "#FFD700",
    description: "You have no special abilities. Use your vote wisely during the day.",
    nightAction: "No night action - sleep tight!",
    winCondition: "Villagers win when all Mafia are eliminated."
  }
};

// ------------------ Helper Functions ------------------ //
function safeRoomId(id) {
  return String(id || "").trim().toUpperCase();
}

function emitLobbyUpdate(roomId) {
  const game = games[roomId];
  if (!game || !game.players) return;
  
  console.log(`[Room ${roomId}] Sending lobby update to ${Object.keys(game.players).length} players`);
  
  io.to(roomId).emit("lobbyUpdate", {
    players: game.players,
    hostId: game.hostId
  });
}

function assignRoles(playerCount) {
  const roles = [];
  const mafiaCount = Math.max(1, Math.floor(playerCount / 4));
  
  // Add Mafia
  for (let i = 0; i < mafiaCount; i++) {
    roles.push("Mafia");
  }
  
  // Add special roles
  roles.push("Detective");
  roles.push("Doctor");
  
  // Fill remaining with Villagers
  while (roles.length < playerCount) {
    roles.push("Villager");
  }
  
  // Shuffle roles
  return roles.sort(() => Math.random() - 0.5);
}

function checkWinConditions(game, roomId) {
  if (!game || game.status === "finished") return;
  
  const alivePlayers = Object.values(game.players).filter(p => p.alive);
  const mafiaAlive = alivePlayers.filter(p => p.role === "Mafia").length;
  const villagersAlive = alivePlayers.length - mafiaAlive;
  
  let winner = null;
  
  if (mafiaAlive === 0) {
    winner = "Villagers";
    console.log(`[Room ${roomId}] Villagers win! All Mafia eliminated.`);
  } else if (mafiaAlive >= villagersAlive) {
    winner = "Mafia";
    console.log(`[Room ${roomId}] Mafia win! They outnumber villagers.`);
  }
  
  if (winner) {
    // Prepare role reveal data
    const roleReveal = {};
    Object.values(game.players).forEach(player => {
      roleReveal[player.playerId] = {
        name: player.name,
        role: player.role,
        emoji: ROLE_CONFIG[player.role]?.emoji || "❓"
      };
    });
    
    // Send game over and role reveal
    io.to(roomId).emit("gameOver", { winner });
    io.to(roomId).emit("revealRoles", { roles: roleReveal });
    
    game.status = "finished";
    game.phase = null;
  }
}

// ------------------ Socket.IO Logic ------------------ //
io.on("connection", (socket) => {
  console.log(`✅ New client connected: ${socket.id}`);
  
  // Store connection data
  socket.data.connectionTime = Date.now();

  // --- CREATE or JOIN ROOM ---
  socket.on("createOrJoinRoom", ({ roomId, name, playerId }, callback) => {
    const rId = safeRoomId(roomId);
    const pId = playerId || uuidv4();
    const pName = String(name || "Player").trim() || "Player";

    if (!pName) {
      return callback?.({ success: false, message: "Name is required" });
    }

    // Initialize room if it doesn't exist
    if (!games[rId]) {
      games[rId] = {
        players: {},
        status: "waiting",
        phase: null,
        nightActions: {},
        votes: {},
        hostId: pId,
        lastActive: Date.now(),
        createdAt: Date.now()
      };
      console.log(`[Room ${rId}] 🆕 Created by ${pName} (${pId})`);
    }

    const game = games[rId];
    
    // Check if player already exists (by socket.id or playerId)
    let existingPlayerId = null;
    Object.entries(game.players).forEach(([pid, player]) => {
      if (player.socketId === socket.id) {
        existingPlayerId = pid;
      }
    });

    if (existingPlayerId) {
      // Player reconnecting - update socket ID
      game.players[existingPlayerId].socketId = socket.id;
      console.log(`[Room ${rId}] 🔄 ${pName} reconnected`);
    } else {
      // New player joining
      game.players[pId] = {
        playerId: pId,
        socketId: socket.id,
        name: pName,
        role: null,
        alive: true,
        ready: false,
        joinedAt: Date.now()
      };
      console.log(`[Room ${rId}] 👤 ${pName} joined`);
    }

    // Join socket room
    socket.join(rId);
    socket.data.roomId = rId;
    socket.data.playerId = existingPlayerId || pId;
    
    game.lastActive = Date.now();

    callback?.({ 
      success: true, 
      playerId: existingPlayerId || pId, 
      roomId: rId,
      hostId: game.hostId
    });

    // Broadcast updated lobby state
    emitLobbyUpdate(rId);
  });

  // --- PLAYER READY TOGGLE ---
  socket.on("playerReady", ({ roomId, playerId, ready }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game || !game.players[playerId]) {
      console.log(`[Room ${rId}] ❌ Player ${playerId} not found for ready toggle`);
      return;
    }

    // Update ready status
    const wasReady = game.players[playerId].ready;
    game.players[playerId].ready = Boolean(ready);
    game.lastActive = Date.now();
    
    console.log(`[Room ${rId}] ${game.players[playerId].name} ${wasReady ? 'unready' : 'ready'} → ${ready ? 'READY ✅' : 'NOT READY ❌'}`);
    
    // Broadcast update
    emitLobbyUpdate(rId);
  });

  // --- START GAME ---
  socket.on("startGame", ({ roomId, playerId }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game) {
      socket.emit("errorMsg", "Room not found");
      return;
    }
    
    // Check if sender is host
    if (game.hostId !== playerId) {
      socket.emit("errorMsg", "Only the host can start the game");
      return;
    }

    const playersList = Object.values(game.players);
    const minPlayers = 3;
    
    // Validation checks
    if (playersList.length < minPlayers) {
      socket.emit("errorMsg", `Need at least ${minPlayers} players to start`);
      return;
    }
    
    if (!playersList.every(p => p.ready)) {
      const notReadyPlayers = playersList.filter(p => !p.ready).map(p => p.name);
      socket.emit("errorMsg", `Waiting for: ${notReadyPlayers.join(', ')}`);
      return;
    }

    console.log(`[Room ${rId}] 🎮 Starting game with ${playersList.length} players`);
    
    // Notify all players that game is starting
    io.to(rId).emit("gameStarting");
    
    // Assign roles
    const playerIds = Object.keys(game.players);
    const roles = assignRoles(playerIds.length);
    
    playerIds.forEach((pid, idx) => {
      game.players[pid].role = roles[idx];
      game.players[pid].alive = true;
      console.log(`[Room ${rId}] ${game.players[pid].name} → ${game.players[pid].role}`);
    });

    // Update game state
    game.status = "playing";
    game.phase = "roleReveal";
    game.nightActions = {};
    game.votes = {};
    game.lastActive = Date.now();

    // Send each player their role with a delay for dramatic effect
    playerIds.forEach((pid, index) => {
      setTimeout(() => {
        const playerSocket = io.sockets.sockets.get(game.players[pid].socketId);
        if (playerSocket) {
          const role = game.players[pid].role;
          const roleConfig = ROLE_CONFIG[role] || ROLE_CONFIG.Villager;
          
          playerSocket.emit("roleAssigned", {
            roomId: rId,
            role: role,
            roleData: {
              ...roleConfig,
              name: game.players[pid].name
            }
          });
        }
      }, index * 200); // Stagger role reveals
    });

    // After 5 seconds, start the first night
    setTimeout(() => {
      game.phase = "night";
      io.to(rId).emit("nightBegins", { 
        duration: 60,
        players: game.players 
      });
      console.log(`[Room ${rId}] 🌙 Night phase begins (60s)`);
    }, 5000);
  });

  // --- NIGHT ACTION ---
  socket.on("nightAction", ({ roomId, playerId, actionType, targetId }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game || game.phase !== "night" || !game.players[playerId] || !game.players[playerId].alive) {
      console.log(`[Room ${rId}] ❌ Invalid night action from ${playerId}`);
      return;
    }

    // Store night action
    if (!game.nightActions) game.nightActions = {};
    game.nightActions[playerId] = { actionType, targetId, timestamp: Date.now() };
    
    const playerName = game.players[playerId].name;
    const targetName = game.players[targetId]?.name || "Unknown";
    console.log(`[Room ${rId}] 🌙 ${playerName} (${game.players[playerId].role}) → ${actionType} → ${targetName}`);

    // If player is Detective, send investigation result immediately
    if (game.players[playerId].role === "Detective" && actionType === "investigate") {
      const target = game.players[targetId];
      if (target) {
        socket.emit("investigationResult", {
          targetId: targetId,
          targetName: target.name,
          isMafia: target.role === "Mafia"
        });
        console.log(`[Room ${rId}] 🔍 Detective ${playerName} investigated ${targetName} (Mafia: ${target.role === "Mafia"})`);
      }
    }

    // Check if all night actions are complete
    const alivePlayers = Object.values(game.players).filter(p => p.alive);
    const nightRolePlayers = alivePlayers.filter(p => p.role !== "Villager");
    
    if (Object.keys(game.nightActions).length >= nightRolePlayers.length) {
      console.log(`[Room ${rId}] 🌙 All night actions complete, processing...`);
      processNightActions(game, rId);
    }
  });

  // --- DAY VOTE ---
  socket.on("dayVote", ({ roomId, playerId, targetId }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game || game.phase !== "day" || !game.players[playerId] || !game.players[playerId].alive) {
      console.log(`[Room ${rId}] ❌ Invalid day vote from ${playerId}`);
      return;
    }

    // Store vote
    if (!game.votes) game.votes = {};
    game.votes[playerId] = targetId;
    
    const voterName = game.players[playerId].name;
    const targetName = game.players[targetId]?.name || "Unknown";
    console.log(`[Room ${rId}] ☀️ ${voterName} voted for ${targetName}`);

    // Send vote update to all players
    io.to(rId).emit("voteUpdate", { votes: game.votes });

    // Check if all alive players have voted
    const alivePlayers = Object.values(game.players).filter(p => p.alive);
    if (Object.keys(game.votes).length >= alivePlayers.length) {
      console.log(`[Room ${rId}] ☀️ All votes in, tallying...`);
      processDayVotes(game, rId);
    }
  });

  // --- LEAVE LOBBY ---
  socket.on("leaveLobby", ({ roomId, playerId }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game || !game.players[playerId]) {
      console.log(`[Room ${rId}] ❌ Player ${playerId} not found for leave`);
      return;
    }

    const playerName = game.players[playerId].name;
    const wasHost = game.hostId === playerId;
    
    // Remove player
    delete game.players[playerId];
    socket.leave(rId);
    
    console.log(`[Room ${rId}] 🚪 ${playerName} left the lobby`);

    // Handle host reassignment
    if (wasHost && Object.keys(game.players).length > 0) {
      const newHostId = Object.keys(game.players)[0];
      game.hostId = newHostId;
      io.to(rId).emit("hostAssigned", { hostId: newHostId });
      console.log(`[Room ${rId}] 👑 New host is ${game.players[newHostId].name}`);
    }

    // Clean up empty room
    if (Object.keys(game.players).length === 0) {
      delete games[rId];
      console.log(`[Room ${rId}] 🗑️ Room deleted (empty)`);
      return;
    }

    game.lastActive = Date.now();
    emitLobbyUpdate(rId);
  });

  // --- DISCONNECT ---
  socket.on("disconnect", () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    
    if (roomId && playerId) {
      const game = games[roomId];
      if (game && game.players[playerId]) {
        console.log(`[Room ${roomId}] ⚠️ ${game.players[playerId].name} disconnected`);
        game.lastActive = Date.now();
        
        // If game is in progress, mark player as disconnected but keep in game
        if (game.status === "playing") {
          // Keep player in game for potential reconnection
          console.log(`[Room ${roomId}] ${game.players[playerId].name} remains in game (can reconnect)`);
        }
      }
    }
  });

  // --- RECONNECT TO ROOM ---
  socket.on("reconnectToRoom", ({ roomId, playerId }, callback) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game || !game.players[playerId]) {
      console.log(`[Room ${rId}] ❌ Reconnection failed for ${playerId}`);
      return callback?.({ success: false, message: "Cannot reconnect to room" });
    }

    // Update socket ID
    game.players[playerId].socketId = socket.id;
    socket.join(rId);
    socket.data.roomId = rId;
    socket.data.playerId = playerId;
    
    console.log(`[Room ${rId}] 🔄 ${game.players[playerId].name} reconnected successfully`);
    
    game.lastActive = Date.now();
    
    // Send current game state to reconnecting player
    if (game.status === "playing") {
      socket.emit("gameStateUpdate", {
        phase: game.phase,
        players: game.players,
        role: game.players[playerId].role,
        alive: game.players[playerId].alive
      });
    } else {
      emitLobbyUpdate(rId);
    }
    
    callback?.({ success: true });
  });

  // --- Helper Functions for Game Logic ---
  function processNightActions(game, roomId) {
    const kills = new Set();
    const saves = new Set();
    const investigations = [];

    // Process each night action
    for (const [playerId, action] of Object.entries(game.nightActions)) {
      const actor = game.players[playerId];
      if (!actor || !actor.alive) continue;

      if (actor.role === "Mafia" && action.actionType === "kill") {
        kills.add(action.targetId);
      }
      
      if (actor.role === "Doctor" && action.actionType === "save") {
        saves.add(action.targetId);
      }
    }

    // Apply kills (unless saved by Doctor)
    let killedPlayers = [];
    kills.forEach(targetId => {
      if (!saves.has(targetId) && game.players[targetId] && game.players[targetId].alive) {
        game.players[targetId].alive = false;
        killedPlayers.push(game.players[targetId].name);
      }
    });

    // Clear night actions
    game.nightActions = {};
    game.phase = "day";
    game.lastActive = Date.now();

    // Send day begins event
    io.to(roomId).emit("dayBegins", { 
      duration: 90,
      players: game.players,
      killedTonight: killedPlayers
    });
    
    console.log(`[Room ${roomId}] ☀️ Day phase begins. Killed tonight: ${killedPlayers.join(', ') || 'No one'}`);

    // Check win conditions
    checkWinConditions(game, roomId);
  }

  function processDayVotes(game, roomId) {
    // Tally votes
    const tally = {};
    Object.values(game.votes).forEach(targetId => {
      tally[targetId] = (tally[targetId] || 0) + 1;
    });

    // Find player(s) with most votes
    const maxVotes = Math.max(...Object.values(tally));
    const eliminatedCandidates = Object.keys(tally).filter(pid => tally[pid] === maxVotes);

    let eliminatedPlayer = null;
    
    if (eliminatedCandidates.length === 1) {
      // Clear winner
      eliminatedPlayer = eliminatedCandidates[0];
    } else if (eliminatedCandidates.length > 1) {
      // Tie - no one gets eliminated
      console.log(`[Room ${roomId}] 🤝 Vote tie! No one eliminated.`);
    }

    // Eliminate player if there's a clear winner
    if (eliminatedPlayer && game.players[eliminatedPlayer] && game.players[eliminatedPlayer].alive) {
      game.players[eliminatedPlayer].alive = false;
      const eliminatedName = game.players[eliminatedPlayer].name;
      const eliminatedRole = game.players[eliminatedPlayer].role;
      
      console.log(`[Room ${roomId}] ☠️ ${eliminatedName} was eliminated (${eliminatedRole})`);
      
      // Send elimination event
      io.to(roomId).emit("playerEliminated", {
        playerId: eliminatedPlayer,
        name: eliminatedName,
        role: eliminatedRole,
        votes: tally[eliminatedPlayer]
      });
    }

    // Reset votes and switch to night
    game.votes = {};
    game.phase = "night";
    game.lastActive = Date.now();

    // Check win conditions
    checkWinConditions(game, roomId);

    // If game is still ongoing, start next night
    if (game.status === "playing") {
      setTimeout(() => {
        io.to(roomId).emit("nightBegins", { 
          duration: 60,
          players: game.players 
        });
        console.log(`[Room ${roomId}] 🌙 Next night begins`);
      }, 3000); // 3 second delay before next night
    }
  }
});

// --- Periodic Cleanup ---
setInterval(() => {
  const now = Date.now();
  Object.entries(games).forEach(([roomId, game]) => {
    // Clean up empty rooms
    if (!game.players || Object.keys(game.players).length === 0) {
      console.log(`🗑️ Cleaning up empty room: ${roomId}`);
      delete games[roomId];
      return;
    }
    
    // Clean up inactive rooms (no activity for 5 minutes)
    if (now - game.lastActive > ROOM_EXPIRY_MS) {
      console.log(`🗑️ Cleaning up inactive room: ${roomId}`);
      delete games[roomId];
      return;
    }
    
    // Remove disconnected players who haven't reconnected in 2 minutes
    if (game.status === "waiting") {
      Object.entries(game.players).forEach(([playerId, player]) => {
        const socketExists = io.sockets.sockets.get(player.socketId);
        if (!socketExists && now - game.lastActive > 120000) {
          console.log(`[Room ${roomId}] Removing disconnected player: ${player.name}`);
          delete game.players[playerId];
          
          // If host left, assign new host
          if (game.hostId === playerId && Object.keys(game.players).length > 0) {
            game.hostId = Object.keys(game.players)[0];
            io.to(roomId).emit("hostAssigned", { hostId: game.hostId });
          }
        }
      });
      
      // Update lobby if players were removed
      if (Object.keys(game.players).length > 0) {
        emitLobbyUpdate(roomId);
      }
    }
  });
}, 30000); // Run every 30 seconds

// ------------------ Start Server ------------------ //
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready`);
});