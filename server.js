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
  const alivePlayers = Object.values(game.players ?? {}).filter((p) => p.alive);
  const mafiaAlive = alivePlayers.filter((p) => p.role === "Mafia").length;
  const villagersAlive = alivePlayers.length - mafiaAlive;

  if (mafiaAlive === 0) {
    io.to(roomId).emit("gameOver", { winner: "Villagers" });
    io.to(roomId).emit("revealRoles", {
      roles: Object.fromEntries(
        Object.entries(game.players || {}).map(([id, p]) => [
          id,
          { name: p.name, role: p.role },
        ])
      ),
    });
    game.status = "finished";
  } else if (mafiaAlive >= villagersAlive) {
    io.to(roomId).emit("gameOver", { winner: "Mafia" });
    io.to(roomId).emit("revealRoles", {
      roles: Object.fromEntries(
        Object.entries(game.players || {}).map(([id, p]) => [
          id,
          { name: p.name, role: p.role },
        ])
      ),
    });
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

    if (!safeName) return socket.emit("errorMsg", "Name is required");

    if (!games[safeRoom]) {
      games[safeRoom] = {
        players: {},
        status: "waiting",
        phase: null,
        nightActions: {},
        hostId: socket.id,
      };
    }

    games[safeRoom].players[socket.id] = {
      id: socket.id,
      name: safeName,
      role: null,
      alive: true,
      ready: false,
    };
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
    if (!game) return socket.emit("errorMsg", "Room not found");

    game.players[socket.id] = {
      id: socket.id,
      name: safeName,
      role: null,
      alive: true,
      ready: false,
    };
    socket.join(safeRoom);

    io.to(safeRoom).emit("lobbyUpdate", {
      players: game.players ?? {},
      hostId: game.hostId ?? null,
    });
  });

  // --- Player Ready Toggle ---
  socket.on("playerReady", ({ roomId, ready }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const game = games[safeRoom];
    if (!game || !game.players[socket.id]) return;

    game.players[socket.id].ready = !!ready;

    io.to(safeRoom).emit("lobbyUpdate", {
      players: game.players ?? {},
      hostId: game.hostId ?? null,
    });
  });

  // --- Start Game (Only Host & Min Players & All Ready) ---
  socket.on("startGame", ({ roomId }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const game = games[safeRoom];
    if (!game) return socket.emit("errorMsg", "Room not found");
    if (game.hostId !== socket.id)
      return socket.emit("errorMsg", "Only the host can start the game");

    const playersList = Object.values(game.players ?? {});
    const minPlayers = 3;
    const allReady = playersList.length >= minPlayers && playersList.every(p => p.ready);

    if (!allReady)
      return socket.emit(
        "errorMsg",
        `Need at least ${minPlayers} players and everyone ready`
      );

    // Assign roles
    const ids = Object.keys(game.players);
    const roles = assignRoles(ids.length);
    ids.forEach((id, idx) => {
      game.players[id].role = roles[idx];
      game.players[id].alive = true;
    });
    game.status = "night";
    game.phase = "night";

    ids.forEach((id) => {
      io.to(id).emit("gameStarted", {
        roomId: safeRoom,
        role: game.players[id].role,
      });
    });

    io.to(safeRoom).emit("nightBegins");
  });

  // --- Leave Lobby / Disconnect Handling ---
  function handleLeave(roomId) {
    const game = games[roomId];
    if (!game) return;

    const wasHost = game.hostId === socket.id;
    if (game.players?.[socket.id]) delete game.players[socket.id];
    socket.leave(roomId);

    if (wasHost) {
      const remaining = Object.keys(game.players ?? {});
      game.hostId = remaining.length ? remaining[0] : null;
    }

    if (Object.keys(game.players ?? {}).length === 0) {
      delete games[roomId];
    } else {
      io.to(roomId).emit("lobbyUpdate", {
        players: game.players ?? {},
        hostId: game.hostId ?? null,
      });
    }
  }

  socket.on("leaveLobby", ({ roomId }) => handleLeave(String(roomId).toUpperCase()));
  socket.on("disconnect", () => {
    Object.keys(games).forEach(roomId => handleLeave(roomId));
  });

  // --- Night & Day Logic (unchanged from your version) ---
  socket.on("nightAction", ({ roomId, actionType, targetId }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const game = games[safeRoom];
    if (!game || game.phase !== "night") return;

    if (!game.nightActions) game.nightActions = {};

    const at = (actionType || "").toString().toLowerCase();
    if (at === "kill" || at === "mafia") game.nightActions.mafiaVictim = targetId;
    if (at === "save" || at === "doctor") game.nightActions.doctorSave = targetId;
    if (at === "investigate" || at === "detective")
      game.nightActions.detectiveCheck = targetId;

    if (game.nightActions.mafiaVictim) {
      const victim = game.nightActions.mafiaVictim;
      const saved = game.nightActions.doctorSave;

      if (victim && victim !== saved && game.players[victim]) {
        game.players[victim].alive = false;
        io.to(safeRoom).emit("playerEliminated", {
          playerId: victim,
          name: game.players[victim].name,
          role: game.players[victim].role,
        });
      }

      if (game.nightActions.detectiveCheck) {
        const checkedId = game.nightActions.detectiveCheck;
        const detectiveId = Object.keys(game.players ?? {}).find(
          (id) => game.players[id].role === "Detective"
        );
        if (detectiveId && game.players[checkedId]) {
          io.to(detectiveId).emit("detectiveResult", {
            playerId: checkedId,
            role: game.players[checkedId].role,
          });
        }
      }

      game.phase = "day";
      game.nightActions = {};
      io.to(safeRoom).emit("phaseChange", { phase: "day" });

      checkWinConditions(game, safeRoom);
    }
  });

  socket.on("dayVote", ({ roomId, votedId }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const game = games[safeRoom];
    if (!game || game.phase !== "day") return;

    if (!game.votes) game.votes = {};
    if (votedId) game.votes[votedId] = (game.votes[votedId] || 0) + 1;

    io.to(safeRoom).emit("voteUpdate", {
      votes: game.votes,
      alive: Object.fromEntries(
        Object.entries(game.players || {}).map(([id, p]) => [id, !!p.alive])
      ),
    });

    const totalVotes = Object.values(game.votes).reduce((a, b) => a + b, 0);
    const aliveCount = Object.values(game.players ?? {}).filter(p => p.alive).length;

    if (aliveCount > 0 && totalVotes >= aliveCount) {
      const maxVotes = Math.max(...Object.values(game.votes));
      const eliminatedId = Object.keys(game.votes).find(id => game.votes[id] === maxVotes);
      if (eliminatedId && game.players[eliminatedId]) {
        game.players[eliminatedId].alive = false;
        io.to(safeRoom).emit("playerEliminated", {
          playerId: eliminatedId,
          name: game.players[eliminatedId].name,
          role: game.players[eliminatedId].role,
        });
      }

      game.votes = {};
      game.phase = "night";
      io.to(safeRoom).emit("phaseChange", { phase: "night" });

      checkWinConditions(game, safeRoom);
    }
  });
});

// ------------------ Start Server ------------------ //
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));