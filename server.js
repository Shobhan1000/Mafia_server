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
const ROOM_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Role configuration with emojis
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
    hostId: game.hostId,
    roleSettings: game.roleSettings || getDefaultRoleSettings()
  });
}

function getDefaultRoleSettings() {
  return {
    mafiaCount: 1,
    detectiveCount: 1,
    doctorCount: 1,
    villagerCount: 1 // This will be auto-calculated based on player count
  };
}

function assignRoles(game, roomId) {
  const playerIds = Object.keys(game.players);
  const playerCount = playerIds.length;
  
  // Get role settings or use defaults
  const settings = game.roleSettings || getDefaultRoleSettings();
  
  const roles = [];
  
  // Add Mafia
  for (let i = 0; i < Math.min(settings.mafiaCount, playerCount); i++) {
    roles.push("Mafia");
  }
  
  // Add Detective
  for (let i = 0; i < Math.min(settings.detectiveCount, playerCount - roles.length); i++) {
    roles.push("Detective");
  }
  
  // Add Doctor
  for (let i = 0; i < Math.min(settings.doctorCount, playerCount - roles.length); i++) {
    roles.push("Doctor");
  }
  
  // Fill remaining with Villagers
  while (roles.length < playerCount) {
    roles.push("Villager");
  }
  
  // If we have too many roles (shouldn't happen with proper validation), trim
  if (roles.length > playerCount) {
    roles.length = playerCount;
  }
  
  // Shuffle roles
  return roles.sort(() => Math.random() - 0.5);
}

function validateRoleSettings(settings, playerCount) {
  const totalRequested = settings.mafiaCount + settings.detectiveCount + settings.doctorCount;
  
  if (totalRequested > playerCount) {
    return {
      valid: false,
      message: `Too many special roles requested. You have ${playerCount} players but requested ${totalRequested} special roles.`
    };
  }
  
  if (settings.mafiaCount < 1) {
    return {
      valid: false,
      message: "You need at least 1 Mafia member."
    };
  }
  
  if (settings.detectiveCount < 0 || settings.doctorCount < 0) {
    return {
      valid: false,
      message: "Role counts cannot be negative."
    };
  }
  
  return { valid: true };
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
        createdAt: Date.now(),
        roleSettings: getDefaultRoleSettings()
      };
      console.log(`[Room ${rId}] 🆕 Created by ${pName} (${pId})`);
    }

    const game = games[rId];
    
    // Check if player already exists (by socket.id)
    let existingPlayerId = null;
    Object.entries(game.players).forEach(([pid, player]) => {
      if (player.socketId === socket.id) {
        existingPlayerId = pid;
      }
    });

    if (existingPlayerId) {
      // Player reconnecting - update socket ID
      game.players[existingPlayerId].socketId = socket.id;
      game.players[existingPlayerId].name = pName;
      console.log(`[Room ${rId}] 🔄 ${game.players[existingPlayerId].name} reconnected`);
    } else if (game.players[pId]) {
      // Player reconnecting with stored ID
      game.players[pId].socketId = socket.id;
      game.players[pId].name = pName;
      console.log(`[Room ${rId}] 🔄 ${pName} reconnected with stored ID`);
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
    socket.data.playerId = pId;
    
    game.lastActive = Date.now();

    callback?.({ 
      success: true, 
      playerId: pId, 
      roomId: rId,
      hostId: game.hostId,
      roleSettings: game.roleSettings
    });

    // Broadcast updated lobby state
    emitLobbyUpdate(rId);
  });

  // --- UPDATE ROLE SETTINGS (HOST ONLY) ---
  socket.on("updateRoleSettings", ({ roomId, playerId, roleSettings }, callback) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game) {
      return callback?.({ success: false, message: "Room not found" });
    }
    
    // Check if sender is host
    if (game.hostId !== playerId) {
      return callback?.({ success: false, message: "Only the host can update role settings" });
    }
    
    // Validate role settings
    const playerCount = Object.keys(game.players).length;
    const validation = validateRoleSettings(roleSettings, playerCount);
    
    if (!validation.valid) {
      return callback?.({ success: false, message: validation.message });
    }
    
    // Update role settings
    game.roleSettings = {
      mafiaCount: Math.max(1, roleSettings.mafiaCount || 1),
      detectiveCount: Math.max(0, roleSettings.detectiveCount || 1),
      doctorCount: Math.max(0, roleSettings.doctorCount || 1),
      villagerCount: Math.max(0, roleSettings.villagerCount || 1)
    };
    
    game.lastActive = Date.now();
    
    console.log(`[Room ${rId}] ⚙️ Host updated role settings:`, game.roleSettings);
    
    // Broadcast updated settings to all players
    emitLobbyUpdate(rId);
    
    callback?.({ success: true, roleSettings: game.roleSettings });
  });

  // --- PLAYER READY TOGGLE ---
  socket.on("playerReady", ({ roomId, playerId, ready }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game || !game.players[playerId]) {
      console.log(`[Room ${rId}] ❌ Player ${playerId} not found for ready toggle`);
      return;
    }

    const wasReady = game.players[playerId].ready;
    game.players[playerId].ready = Boolean(ready);
    game.lastActive = Date.now();
    
    console.log(`[Room ${rId}] ${game.players[playerId].name} ${wasReady ? 'unready' : 'ready'} → ${ready ? 'READY ✅' : 'NOT READY ❌'}`);
    
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
    
    if (game.hostId !== playerId) {
      socket.emit("errorMsg", "Only the host can start the game");
      return;
    }

    const playersList = Object.values(game.players);
    const minPlayers = 3;
    
    if (playersList.length < minPlayers) {
      socket.emit("errorMsg", `Need at least ${minPlayers} players to start`);
      return;
    }
    
    if (!playersList.every(p => p.ready)) {
      const notReadyPlayers = playersList.filter(p => !p.ready).map(p => p.name);
      socket.emit("errorMsg", `Waiting for: ${notReadyPlayers.join(', ')}`);
      return;
    }
    
    // Validate role settings one more time before starting
    const validation = validateRoleSettings(game.roleSettings, playersList.length);
    if (!validation.valid) {
      socket.emit("errorMsg", validation.message);
      return;
    }

    console.log(`[Room ${rId}] 🎮 Starting game with ${playersList.length} players`);
    
    // Notify all players that game is starting
    io.to(rId).emit("gameStarting");
    
    // Assign roles using the custom settings
    const playerIds = Object.keys(game.players);
    const roles = assignRoles(game, rId);
    
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

    // Send each player their role
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
      }, index * 200);
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

    if (!game.votes) game.votes = {};
    game.votes[playerId] = targetId;
    
    const voterName = game.players[playerId].name;
    const targetName = game.players[targetId]?.name || "Unknown";
    console.log(`[Room ${rId}] ☀️ ${voterName} voted for ${targetName}`);

    io.to(rId).emit("voteUpdate", { votes: game.votes });

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
    
    delete game.players[playerId];
    socket.leave(rId);
    
    console.log(`[Room ${rId}] 🚪 ${playerName} left the lobby`);

    if (wasHost && Object.keys(game.players).length > 0) {
      const newHostId = Object.keys(game.players)[0];
      game.hostId = newHostId;
      io.to(rId).emit("hostAssigned", { hostId: newHostId });
      console.log(`[Room ${rId}] 👑 New host is ${game.players[newHostId].name}`);
    }

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
        
        if (game.status === "playing") {
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

    game.players[playerId].socketId = socket.id;
    socket.join(rId);
    socket.data.roomId = rId;
    socket.data.playerId = playerId;
    
    console.log(`[Room ${rId}] 🔄 ${game.players[playerId].name} reconnected successfully`);
    
    game.lastActive = Date.now();
    
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

    let killedPlayers = [];
    kills.forEach(targetId => {
      if (!saves.has(targetId) && game.players[targetId] && game.players[targetId].alive) {
        game.players[targetId].alive = false;
        killedPlayers.push(game.players[targetId].name);
      }
    });

    game.nightActions = {};
    game.phase = "day";
    game.lastActive = Date.now();

    io.to(roomId).emit("dayBegins", { 
      duration: 90,
      players: game.players,
      killedTonight: killedPlayers
    });
    
    console.log(`[Room ${roomId}] ☀️ Day phase begins. Killed tonight: ${killedPlayers.join(', ') || 'No one'}`);

    checkWinConditions(game, roomId);
  }

  function processDayVotes(game, roomId) {
    const tally = {};
    Object.values(game.votes).forEach(targetId => {
      tally[targetId] = (tally[targetId] || 0) + 1;
    });

    const maxVotes = Math.max(...Object.values(tally));
    const eliminatedCandidates = Object.keys(tally).filter(pid => tally[pid] === maxVotes);

    let eliminatedPlayer = null;
    
    if (eliminatedCandidates.length === 1) {
      eliminatedPlayer = eliminatedCandidates[0];
    } else if (eliminatedCandidates.length > 1) {
      console.log(`[Room ${roomId}] 🤝 Vote tie! No one eliminated.`);
    }

    if (eliminatedPlayer && game.players[eliminatedPlayer] && game.players[eliminatedPlayer].alive) {
      game.players[eliminatedPlayer].alive = false;
      const eliminatedName = game.players[eliminatedPlayer].name;
      const eliminatedRole = game.players[eliminatedPlayer].role;
      
      console.log(`[Room ${roomId}] ☠️ ${eliminatedName} was eliminated (${eliminatedRole})`);
      
      io.to(roomId).emit("playerEliminated", {
        playerId: eliminatedPlayer,
        name: eliminatedName,
        role: eliminatedRole,
        votes: tally[eliminatedPlayer]
      });
    }

    game.votes = {};
    game.phase = "night";
    game.lastActive = Date.now();

    checkWinConditions(game, roomId);

    if (game.status === "playing") {
      setTimeout(() => {
        io.to(roomId).emit("nightBegins", { 
          duration: 60,
          players: game.players 
        });
        console.log(`[Room ${roomId}] 🌙 Next night begins`);
      }, 3000);
    }
  }
});

// --- Periodic Cleanup ---
setInterval(() => {
  const now = Date.now();
  Object.entries(games).forEach(([roomId, game]) => {
    if (!game.players || Object.keys(game.players).length === 0) {
      console.log(`🗑️ Cleaning up empty room: ${roomId}`);
      delete games[roomId];
      return;
    }
    
    // FIXED: Changed ROLE_EXPIRY_MS to ROOM_EXPIRY_MS
    if (now - game.lastActive > ROOM_EXPIRY_MS) {
      console.log(`🗑️ Cleaning up inactive room: ${roomId}`);
      delete games[roomId];
      return;
    }
    
    if (game.status === "waiting") {
      Object.entries(game.players).forEach(([playerId, player]) => {
        const socketExists = io.sockets.sockets.get(player.socketId);
        if (!socketExists && now - game.lastActive > 120000) {
          console.log(`[Room ${roomId}] Removing disconnected player: ${player.name}`);
          delete game.players[playerId];
          
          if (game.hostId === playerId && Object.keys(game.players).length > 0) {
            game.hostId = Object.keys(game.players)[0];
            io.to(roomId).emit("hostAssigned", { hostId: game.hostId });
          }
        }
      });
      
      if (Object.keys(game.players).length > 0) {
        emitLobbyUpdate(roomId);
      }
    }
  });
}, 30000);

// ------------------ Start Server ------------------ //
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.IO server ready`);
});