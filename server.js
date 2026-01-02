const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const games = {}; // { roomId: { players: { playerId: {...} }, hostId, ... } }
const ROOM_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// ------------------ Helper Functions ------------------ //
function assignRoles(playerCount) {
  const roles = [];
  const mafiaCount = Math.max(1, Math.floor(playerCount / 4));
  for (let i = 0; i < mafiaCount; i++) roles.push("Mafia");
  roles.push("Detective");
  roles.push("Doctor");
  while (roles.length < playerCount) roles.push("Villager");
  return roles.sort(() => Math.random() - 0.5);
}

function checkWinConditions(game, roomId) {
  const alivePlayers = Object.values(game.players ?? {}).filter((p) => p.alive);
  const mafiaAlive = alivePlayers.filter((p) => p.role === "Mafia").length;
  const villagersAlive = alivePlayers.length - mafiaAlive;

  if (mafiaAlive === 0) {
    console.log(`[Room ${roomId}] Villagers win!`);
    io.to(roomId).emit("gameOver", { winner: "Villagers" });
    io.to(roomId).emit("revealRoles", {
      roles: Object.fromEntries(
        Object.values(game.players).map((p) => [p.playerId, { name: p.name, role: p.role }])
      ),
    });
    game.status = "finished";
  } else if (mafiaAlive >= villagersAlive) {
    console.log(`[Room ${roomId}] Mafia win!`);
    io.to(roomId).emit("gameOver", { winner: "Mafia" });
    io.to(roomId).emit("revealRoles", {
      roles: Object.fromEntries(
        Object.values(game.players).map((p) => [p.playerId, { name: p.name, role: p.role }])
      ),
    });
    game.status = "finished";
  }
}

function safeRoomId(id) {
  return String(id || "").trim().toUpperCase();
}

function emitLobbyUpdate(roomId) {
  const game = games[roomId];
  if (!game) return;
  io.to(roomId).emit("lobbyUpdate", {
    players: game.players,
    hostId: game.hostId
  });
}

// ------------------ Socket.IO Logic ------------------ //
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // --- Create Room ---
  socket.on("createRoom", ({ roomId, name, playerId }, callback) => {
    const rId = safeRoomId(roomId);
    const pId = playerId || uuidv4();
    const pName = String(name || "Player").trim() || "Player";

    if (!pName) return callback?.({ success: false, message: "Name is required" });

    if (!games[rId]) {
      games[rId] = {
        players: {},
        status: "waiting",
        phase: null,
        nightActions: {},
        hostId: pId,
        lastActive: Date.now()
      };
      console.log(`[Room ${rId}] created by ${pName} (${pId})`);
    }

    games[rId].players[pId] = {
      playerId: pId,
      socketId: socket.id,
      name: pName,
      role: null,
      alive: true,
      ready: false
    };
    socket.join(rId);

    io.to(rId).emit("hostAssigned", { hostId: games[rId].hostId });
    emitLobbyUpdate(rId);

    callback?.({ success: true, playerId: pId, roomId: rId });
  });

  // --- Join Room ---
  socket.on("joinRoom", ({ roomId, name, playerId }, callback) => {
    const rId = safeRoomId(roomId);
    const pId = playerId || uuidv4();
    const pName = String(name || "Player").trim() || "Player";
    const game = games[rId];

    if (!game) return callback?.({ success: false, message: "Room not found" });
    
    // Check if game has players object
    if (!game.players) {
      game.players = {};
    }

    game.players[pId] = {
      playerId: pId,
      socketId: socket.id,
      name: pName,
      role: null,
      alive: true,
      ready: false
    };
    socket.join(rId);

    // Ensure hostId exists, if not set the first player as host
    if (!game.hostId && Object.keys(game.players).length > 0) {
      game.hostId = Object.keys(game.players)[0];
    }

    io.to(rId).emit("hostAssigned", { hostId: game.hostId });
    emitLobbyUpdate(rId);

    callback?.({ success: true, playerId: pId, roomId: rId });
  });

  // --- Reconnect to Room ---
  socket.on("reconnectToRoom", ({ roomId, playerId }, callback) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    if (!game || !game.players || !game.players[playerId]) {
      return callback?.({ success: false, message: "Reconnection failed" });
    }
    game.players[playerId].socketId = socket.id;
    socket.join(rId);
    emitLobbyUpdate(rId);
    callback?.({ success: true });
  });

  // --- Player Ready Toggle ---
  socket.on("playerReady", ({ roomId, playerId, ready }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    if (!game || !game.players || !game.players[playerId]) return;

    game.players[playerId].ready = !!ready;
    console.log(`[Room ${rId}] ${game.players[playerId].name} is now ${ready ? "READY" : "NOT ready"}`);
    emitLobbyUpdate(rId);
  });

  // --- Start Game ---
  socket.on("startGame", ({ roomId, playerId }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    if (!game) return socket.emit("errorMsg", "Room not found");
    if (game.hostId !== playerId) return socket.emit("errorMsg", "Only the host can start the game");

    const playersList = Object.values(game.players ?? {});
    const minPlayers = 3;
    const allReady = playersList.length >= minPlayers && playersList.every((p) => p.ready);

    if (!allReady) return socket.emit("errorMsg", `Need at least ${minPlayers} players and everyone ready`);

    console.log(`[Room ${rId}] Game started`);

    const ids = Object.keys(game.players);
    const roles = assignRoles(ids.length);
    ids.forEach((pid, idx) => {
      game.players[pid].role = roles[idx];
      game.players[pid].alive = true;
      console.log(`[Room ${rId}] ${game.players[pid].name} is ${game.players[pid].role}`);
    });
    game.status = "night";
    game.phase = "night";

    ids.forEach((pid) => {
      io.to(game.players[pid].socketId).emit("gameStarted", {
        roomId: rId,
        role: game.players[pid].role,
      });
    });

    io.to(rId).emit("nightBegins");
  });

  // --- Leave Lobby / Disconnect Handling ---
  socket.on("leaveLobby", ({ roomId, playerId }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    if (!game || !game.players) return;

    const wasHost = game.hostId === playerId;
    delete game.players[playerId];
    socket.leave(rId);

    if (wasHost && Object.keys(game.players).length > 0) {
      const remaining = Object.keys(game.players);
      game.hostId = remaining[0];
      io.to(rId).emit("hostAssigned", { hostId: game.hostId });
    } else if (Object.keys(game.players).length === 0) {
      // If no players left, clean up the room
      delete games[rId];
      return;
    }

    emitLobbyUpdate(rId);
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    for (const [roomId, game] of Object.entries(games)) {
      for (const [playerId, player] of Object.entries(game.players || {})) {
        if (player.socketId === socket.id) {
          game.lastActive = Date.now();
          break;
        }
      }
    }
  });

  // --- Night & Day Logic ---
  socket.on("nightAction", ({ roomId, playerId, actionType, targetId }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    if (!game || game.phase !== "night" || !game.players || !game.players[playerId]) return;

    if (!game.nightActions) game.nightActions = {};
    game.nightActions[playerId] = { actionType, targetId };
    console.log(`[Room ${rId}] ${game.players[playerId].name} (${game.players[playerId].role}) targets ${targetId}`);

    // Check if all alive players have acted
    const alivePlayers = Object.values(game.players).filter(p => p.alive);
    if (Object.keys(game.nightActions).length >= alivePlayers.length) {
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
        if (actor.role === "Detective" && action.actionType === "investigate") {
          const target = game.players[action.targetId];
          if (target) {
            io.to(actor.socketId).emit("investigationResult", {
              targetId: action.targetId,
              isMafia: target.role === "Mafia"
            });
          }
        }
      }

      // Apply kills unless saved
      kills.forEach(targetId => {
        if (!saves.has(targetId) && game.players[targetId]) {
          game.players[targetId].alive = false;
          console.log(`[Room ${rId}] ${game.players[targetId].name} was killed`);
        }
      });

      game.nightActions = {};
      game.phase = "day";
      io.to(rId).emit("dayBegins", { players: game.players });
      checkWinConditions(game, rId);
    }
  });

  socket.on("dayVote", ({ roomId, playerId, targetId }) => {
    const rId = safeRoomId(roomId);
    const game = games[rId];
    if (!game || game.phase !== "day" || !game.players || !game.players[playerId]) return;

    if (!game.votes) game.votes = {};
    game.votes[playerId] = targetId;
    console.log(`[Room ${rId}] ${game.players[playerId].name} votes to eliminate ${targetId}`);

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
        console.log(`[Room ${rId}] ${game.players[eliminated].name} was eliminated`);
      }

      game.votes = {};
      game.phase = "night";
      io.to(rId).emit("nightBegins");
      checkWinConditions(game, rId);
    }
  });
});

// --- Periodic Cleanup ---
setInterval(() => {
  const now = Date.now();
  for (const [roomId, game] of Object.entries(games)) {
    if (!game.players || Object.keys(game.players).length === 0) {
      console.log(`Deleting empty room ${roomId}`);
      delete games[roomId];
    } else if (now - game.lastActive > ROOM_EXPIRY_MS) {
      const allDisconnected = Object.values(game.players).every(p => {
        const socketExists = io.sockets.sockets.get(p.socketId);
        return !socketExists;
      });
      if (allDisconnected) {
        console.log(`Deleting inactive room ${roomId}`);
        delete games[roomId];
      }
    }
  }
}, 30000);

// ------------------ Start Server ------------------ //
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));