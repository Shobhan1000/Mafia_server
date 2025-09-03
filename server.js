const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const games = {}; // store game rooms

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
  const alivePlayers = Object.values(game.players ?? {}).filter(p => p.alive);
  const mafiaAlive = alivePlayers.filter(p => p.role === "Mafia").length;
  const villagersAlive = alivePlayers.length - mafiaAlive;

  if (mafiaAlive === 0) {
    io.to(roomId).emit("gameOver", { winner: "Villagers" });
    io.to(roomId).emit("revealRoles", { roles: Object.fromEntries(Object.entries(game.players||{}).map(([id,p])=>[id,{ name: p.name, role: p.role }])) });
    game.status = "finished";
  } else if (mafiaAlive >= villagersAlive) {
    io.to(roomId).emit("gameOver", { winner: "Mafia" });
    io.to(roomId).emit("revealRoles", { roles: Object.fromEntries(Object.entries(game.players||{}).map(([id,p])=>[id,{ name: p.name, role: p.role }])) });
    game.status = "finished";
  }
}

// ------------------ Socket.IO Logic ------------------ //
io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // --- Create Room ---
  socket.on("createRoom", ({ roomId, name }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const safeName = String(name || "Player").trim() || "Player";

    if (!safeName) {
      socket.emit("errorMsg", "Name is required to create a room");
      return;
    }

    if (!games[safeRoom]) {
      games[safeRoom] = {
        players: {},
        status: "waiting",
        phase: null,
        nightActions: {},
        hostId: socket.id,
      };
    }

    games[safeRoom].players[socket.id] = { id: socket.id, name: safeName, role: null, alive: true, ready: false };
    socket.join(safeRoom);

    io.to(safeRoom).emit("lobbyUpdate", {
      players: games[safeRoom].players ?? {},
      hostId: games[safeRoom].hostId ?? null,
    });
  });

  // --- Join Room ---
  socket.on("joinRoom", ({ roomId, name }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const safeName = String(name || "Player").trim() || "Player";

    const game = games[safeRoom];
    if (!safeName) {
      socket.emit("errorMsg", "Name is required to join a room");
      return;
    }
    if (!game) {
      socket.emit("errorMsg", "Room not found");
      return;
    }

    game.players[socket.id] = { id: socket.id, name: safeName, role: null, alive: true, ready: false };
    socket.join(safeRoom);

    io.to(safeRoom).emit("lobbyUpdate", {
      players: game.players ?? {},
      hostId: game.hostId ?? null,
    });
  });

  
  // --- Player Ready ---
  socket.on("playerReady", ({ roomId, ready }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const game = games[safeRoom];
    if (!game || !game.players || !game.players[socket.id]) return;
    game.players[socket.id].ready = !!ready;

    io.to(safeRoom).emit("lobbyUpdate", {
      players: game.players ?? {},
      hostId: game.hostId ?? null,
    });
  });
// --- Start Game & Assign Roles (Only Host) ---
  socket.on("startGame", ({ roomId }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const game = games[safeRoom];
    if (!game) return;

    if (game.hostId !== socket.id) {
      socket.emit("errorMsg", "Only the host can start the game");
      return;
    }

    const playerIds = Object.keys(game.players ?? {});

    const roles = assignRoles(playerIds.length);

    playerIds.forEach((id, index) => {
      game.players[id].role = roles[index];
      io.to(id).emit("roleAssigned", game.players[id].role);
    });

    // notify mafia with list of other mafia
    const mafiaIds = playerIds.filter(id => game.players[id].role === "Mafia");
    mafiaIds.forEach(id => {
      const others = mafiaIds.filter(mid => mid !== id).map(mid => ({ id: mid, name: game.players[mid].name }));
      io.to(id).emit("mafiaMembers", others);
    });

    game.status = "inProgress";
    game.phase = "night";
    game.nightActions = {};
    io.to(safeRoom).emit("gameStarted", game.players ?? {});
    io.to(safeRoom).emit("phaseChange", { phase: "night" });
  });

  // --- Night Actions ---
  socket.on("nightAction", ({ roomId, actionType, targetId }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const game = games[safeRoom];
    if (!game || game.phase !== "night") return;

    if (!game.nightActions) game.nightActions = {};

    if (actionType === "mafia") game.nightActions.mafiaVictim = targetId;
    if (actionType === "doctor") game.nightActions.doctorSave = targetId;
    if (actionType === "detective") game.nightActions.detectiveCheck = targetId;

    if (game.nightActions.mafiaVictim) {
      const victim = game.nightActions.mafiaVictim;
      const saved = game.nightActions.doctorSave;

      if (victim && victim !== saved && game.players[victim]) {
        game.players[victim].alive = false;
        io.to(safeRoom).emit("playerEliminated", { playerId: victim, name: game.players[victim].name });
      }

      if (game.nightActions.detectiveCheck) {
        const checkedId = game.nightActions.detectiveCheck;
        const detectiveId = Object.keys(game.players ?? {}).find(id => game.players[id].role === "Detective");
        if (detectiveId && game.players[checkedId]) {
          const roleChecked = game.players[checkedId].role;
          io.to(detectiveId).emit("detectiveResult", { playerId: checkedId, role: roleChecked });
        }
      }

      game.phase = "day";
      game.nightActions = {};
      io.to(safeRoom).emit("phaseChange", { phase: "day" });

      checkWinConditions(game, safeRoom);
    }
  });

  // --- Day Voting ---
  socket.on("dayVote", ({ roomId, votedId }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const game = games[safeRoom];
    if (!game || game.phase !== "day") return;

    if (!game.votes) game.votes = {};
    if (votedId) {
      game.votes[votedId] = (game.votes[votedId] || 0) + 1;
    }

    io.to(safeRoom).emit("voteUpdate", { votes: game.votes, alive: Object.fromEntries(Object.entries(game.players||{}).map(([id,p])=>[id, !!p.alive])) });

    const totalVotes = Object.values(game.votes).reduce((a, b) => a + b, 0);
    const aliveCount = Object.values(game.players ?? {}).filter(p => p.alive).length;

    if (aliveCount > 0 && totalVotes >= aliveCount) {
      const maxVotes = Math.max(...Object.values(game.votes));
      const eliminatedId = Object.keys(game.votes).find(id => game.votes[id] === maxVotes);
      if (eliminatedId && game.players[eliminatedId]) {
        game.players[eliminatedId].alive = false;
        io.to(safeRoom).emit("playerEliminated", { playerId: eliminatedId, name: game.players[eliminatedId].name });
      }

      game.votes = {};
      game.phase = "night";
      io.to(safeRoom).emit("phaseChange", { phase: "night" });

      checkWinConditions(game, safeRoom);
    }
  });

  // --- Disconnect ---
  socket.on("disconnect", () => {
    for (const [roomId, game] of Object.entries(games)) {
      if (game.players?.[socket.id]) {
        delete game.players[socket.id];

        if (game.hostId === socket.id) {
          const remainingPlayers = Object.keys(game.players ?? {});
          game.hostId = remainingPlayers.length > 0 ? remainingPlayers[0] : null;
        }

        io.to(roomId).emit("lobbyUpdate", {
          players: game.players ?? {},
          hostId: game.hostId ?? null,
        });

        if (Object.keys(game.players ?? {}).length === 0) {
          delete games[roomId];
        }
      }
    }
  });
});

// ------------------ Start Server ------------------ //
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));