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
const ROOM_EXPIRY_MS = 5 * 60 * 1000;

// Helper Functions
function safeRoomId(id) {
  return String(id || "").trim().toUpperCase();
}

function emitLobbyUpdate(roomId) {
  const game = games[roomId];
  if (!game || !game.players) return;
  
  console.log(`[Room ${roomId}] Emitting lobby update with ${Object.keys(game.players).length} players:`);
  Object.values(game.players).forEach(p => {
    console.log(`  - ${p.name} (${p.playerId}): ready=${p.ready}, host=${p.playerId === game.hostId}`);
  });
  
  io.to(roomId).emit("lobbyUpdate", {
    players: game.players,
    hostId: game.hostId
  });
}

function assignRoles(playerCount) {
  const roles = [];
  const mafiaCount = Math.max(1, Math.floor(playerCount / 4));
  for (let i = 0; i < mafiaCount; i++) roles.push("Mafia");
  roles.push("Detective");
  roles.push("Doctor");
  while (roles.length < playerCount) roles.push("Villager");
  return roles.sort(() => Math.random() - 0.5);
}

// Socket.IO Logic
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Create or Join Room
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
        hostId: pId,
        lastActive: Date.now()
      };
      console.log(`[Room ${rId}] Created by ${pName}`);
    }

    const game = games[rId];
    
    // Check if player already exists in this room
    const existingPlayer = Object.values(game.players).find(
      p => p.socketId === socket.id || p.playerId === pId
    );

    if (existingPlayer) {
      // Update existing player
      existingPlayer.socketId = socket.id;
      existingPlayer.name = pName;
      console.log(`[Room ${rId}] Updated existing player: ${pName}`);
    } else {
      // Add new player
      game.players[pId] = {
        playerId: pId,
        socketId: socket.id,
        name: pName,
        role: null,
        alive: true,
        ready: false
      };
      console.log(`[Room ${rId}] Added new player: ${pName}`);
    }

    // Join the socket room
    socket.join(rId);
    socket.data.roomId = rId;
    socket.data.playerId = pId;
    
    game.lastActive = Date.now();

    // Send success response
    callback?.({ 
      success: true, 
      playerId: pId, 
      roomId: rId,
      hostId: game.hostId
    });

    // Broadcast update to all in room
    emitLobbyUpdate(rId);
  });

  // Player Ready Toggle
  socket.on("playerReady", ({ roomId, playerId, ready }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game || !game.players[playerId]) {
      console.log(`[Room ${rId}] Player ${playerId} not found for ready toggle`);
      return;
    }

    // Update ready status
    game.players[playerId].ready = Boolean(ready);
    game.lastActive = Date.now();
    
    console.log(`[Room ${rId}] ${game.players[playerId].name} set ready to: ${ready}`);
    
    // Broadcast update
    emitLobbyUpdate(rId);
  });

  // Start Game
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
      socket.emit("errorMsg", `Need at least ${minPlayers} players`);
      return;
    }
    
    if (!playersList.every(p => p.ready)) {
      socket.emit("errorMsg", "All players must be ready");
      return;
    }

    console.log(`[Room ${rId}] Starting game with ${playersList.length} players`);

    // Assign roles
    const playerIds = Object.keys(game.players);
    const roles = assignRoles(playerIds.length);
    
    playerIds.forEach((pid, idx) => {
      game.players[pid].role = roles[idx];
      game.players[pid].alive = true;
    });

    game.status = "night";
    game.phase = "night";

    // Notify all players with their roles
    playerIds.forEach(pid => {
      const playerSocket = io.sockets.sockets.get(game.players[pid].socketId);
      if (playerSocket) {
        playerSocket.emit("gameStarted", {
          roomId: rId,
          role: game.players[pid].role,
        });
      }
    });

    io.to(rId).emit("nightBegins");
  });

  // Leave Lobby
  socket.on("leaveLobby", ({ roomId, playerId }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game || !game.players[playerId]) return;

    const playerName = game.players[playerId].name;
    const wasHost = game.hostId === playerId;
    
    // Remove player
    delete game.players[playerId];
    socket.leave(rId);
    
    console.log(`[Room ${rId}] ${playerName} left the lobby`);

    // Handle host reassignment
    if (wasHost && Object.keys(game.players).length > 0) {
      const newHostId = Object.keys(game.players)[0];
      game.hostId = newHostId;
      io.to(rId).emit("hostAssigned", { hostId: newHostId });
      console.log(`[Room ${rId}] New host is ${game.players[newHostId].name}`);
    }

    // Clean up empty room
    if (Object.keys(game.players).length === 0) {
      delete games[rId];
      console.log(`[Room ${rId}] Room deleted (empty)`);
      return;
    }

    game.lastActive = Date.now();
    emitLobbyUpdate(rId);
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    
    if (roomId && playerId) {
      const game = games[roomId];
      if (game && game.players[playerId]) {
        // Mark as disconnected but keep in list (allow reconnection)
        console.log(`[Room ${roomId}] ${game.players[playerId].name} disconnected`);
        game.lastActive = Date.now();
      }
    }
  });

  // Night Action
  socket.on("nightAction", ({ roomId, playerId, actionType, targetId }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game || game.phase !== "night" || !game.players[playerId]) return;

    game.nightActions[playerId] = { actionType, targetId };
    
    // Check if all alive non-villager roles have acted
    const alivePlayers = Object.values(game.players).filter(p => p.alive);
    const nightRolePlayers = alivePlayers.filter(p => p.role !== "Villager");
    
    if (Object.keys(game.nightActions).length >= nightRolePlayers.length) {
      // Process night actions
      const kills = new Set();
      const saves = new Set();

      for (const [pid, action] of Object.entries(game.nightActions)) {
        const actor = game.players[pid];
        if (!actor || !actor.alive) continue;

        if (actor.role === "Mafia" && action.actionType === "kill") {
          kills.add(action.targetId);
        }
        if (actor.role === "Doctor" && action.actionType === "save") {
          saves.add(action.targetId);
        }
      }

      // Apply kills unless saved
      kills.forEach(targetId => {
        if (!saves.has(targetId) && game.players[targetId]) {
          game.players[targetId].alive = false;
        }
      });

      game.nightActions = {};
      game.phase = "day";
      io.to(rId).emit("dayBegins", { players: game.players });
    }
  });

  // Day Vote
  socket.on("dayVote", ({ roomId, playerId, targetId }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    
    if (!game || game.phase !== "day" || !game.players[playerId]) return;

    if (!game.votes) game.votes = {};
    game.votes[playerId] = targetId;

    const alivePlayers = Object.values(game.players).filter(p => p.alive);
    if (Object.keys(game.votes).length >= alivePlayers.length) {
      // Tally votes
      const tally = {};
      Object.values(game.votes).forEach(v => {
        tally[v] = (tally[v] || 0) + 1;
      });

      const maxVotes = Math.max(...Object.values(tally));
      const eliminated = Object.keys(tally).find(pid => tally[pid] === maxVotes);

      if (eliminated && game.players[eliminated]) {
        game.players[eliminated].alive = false;
      }

      game.votes = {};
      game.phase = "night";
      io.to(rId).emit("nightBegins");
    }
  });
});

// Cleanup empty rooms
setInterval(() => {
  const now = Date.now();
  Object.entries(games).forEach(([roomId, game]) => {
    if (!game.players || Object.keys(game.players).length === 0) {
      console.log(`Cleaning up empty room: ${roomId}`);
      delete games[roomId];
    } else if (now - game.lastActive > ROOM_EXPIRY_MS) {
      console.log(`Cleaning up inactive room: ${roomId}`);
      delete games[roomId];
    }
  });
}, 60000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));