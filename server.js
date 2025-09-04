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
        hostId: socket.id, // creator is always host
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

    console.log(
      `Room created/joined: ${safeRoom} by ${safeName} (${socket.id})`
    );

    io.to(safeRoom).emit("lobbyUpdate", {
      players: games[safeRoom].players ?? {},
      hostId: games[safeRoom].hostId ?? null,
    });
  });

  // --- Join Room (explicit join) ---
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

    game.players[socket.id] = {
      id: socket.id,
      name: safeName,
      role: null,
      alive: true,
      ready: false,
    };
    socket.join(safeRoom);

    console.log(`${safeName} joined room ${safeRoom} (${socket.id})`);

    io.to(safeRoom).emit("lobbyUpdate", {
      players: game.players ?? {},
      hostId: game.hostId ?? null,
    });
  });

  // --- Join Lobby (alias of joinRoom) ---
  socket.on("joinLobby", ({ roomId, name }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const safeName = String(name || "Player").trim() || "Player";

    const game = games[safeRoom];
    if (!game) {
      socket.emit("errorMsg", "Room not found");
      return;
    }
    if (!safeName) {
      socket.emit("errorMsg", "Name is required to join a room");
      return;
    }

    game.players[socket.id] = {
      id: socket.id,
      name: safeName,
      role: null,
      alive: true,
      ready: false,
    };
    socket.join(safeRoom);

    console.log(`${safeName} (joinLobby) joined room ${safeRoom} (${socket.id})`);

    io.to(safeRoom).emit("lobbyUpdate", {
      players: game.players ?? {},
      hostId: game.hostId ?? null,
    });
  });

  // --- Leave Lobby ---
  socket.on("leaveLobby", ({ roomId }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const game = games[safeRoom];
    if (!game) return;

    const wasHost = game.hostId === socket.id;
    if (game.players && game.players[socket.id]) {
      delete game.players[socket.id];
    }
    socket.leave(safeRoom);

    // choose new host if needed
    if (wasHost) {
      const remaining = Object.keys(game.players || {});
      game.hostId = remaining.length ? remaining[0] : null;
    }
    if (Object.keys(game.players || {}).length === 0) {
      delete games[safeRoom];
    } else {
      io.to(safeRoom).emit("lobbyUpdate", {
        players: game.players || {},
        hostId: game.hostId || null,
      });
    }
  });

  // --- Player Ready ---
  socket.on("playerReady", ({ roomId, ready }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const game = games[safeRoom];
    if (!game) return;
    if (!game.players[socket.id]) return;

    game.players[socket.id].ready = !!ready;

    io.to(safeRoom).emit("lobbyUpdate", {
      players: game.players || {},
      hostId: game.hostId || null,
    });
  });

  // --- Start Game & Assign Roles (Only Host) ---
  socket.on("startGame", ({ roomId }) => {
    const safeRoom = String(roomId || "").toUpperCase();
    const game = games[safeRoom];
    if (!game) {
      socket.emit("errorMsg", "Room not found");
      return;
    }

    if (game.hostId !== socket.id) {
      socket.emit("errorMsg", "Only the host can start the game");
      return;
    }
    const pList = Object.values(game.players || {});
    const minPlayers = 3;
    const allReady =
      pList.length >= minPlayers && pList.every((p) => p.ready);
    if (!allReady) {
      socket.emit(
        "errorMsg",
        `Need at least ${minPlayers} players and everyone ready`
      );
      return;
    }

    // assign roles and start
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

  // --- Night Actions ---
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
        console.log(
          `Night elimination in ${safeRoom}: ${game.players[victim].name} (${game.players[victim].role})`
        );
      }

      if (game.nightActions.detectiveCheck) {
        const checkedId = game.nightActions.detectiveCheck;
        const detectiveId = Object.keys(game.players ?? {}).find(
          (id) => game.players[id].role === "Detective"
        );
        if (detectiveId && game.players[checkedId]) {
          const roleChecked = game.players[checkedId].role;
          io.to(detectiveId).emit("detectiveResult", {
            playerId: checkedId,
            role: roleChecked,
          });
          console.log(
            `Detective result in ${safeRoom}: ${game.players[checkedId].name} -> ${roleChecked}`
          );
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

    io.to(safeRoom).emit("voteUpdate", {
      votes: game.votes,
      alive: Object.fromEntries(
        Object.entries(game.players || {}).map(([id, p]) => [id, !!p.alive])
      ),
    });

    const totalVotes = Object.values(game.votes).reduce((a, b) => a + b, 0);
    const aliveCount = Object.values(game.players ?? {}).filter(
      (p) => p.alive
    ).length;

    if (aliveCount > 0 && totalVotes >= aliveCount) {
      const maxVotes = Math.max(...Object.values(game.votes));
      const eliminatedId = Object.keys(game.votes).find(
        (id) => game.votes[id] === maxVotes
      );
      if (eliminatedId && game.players[eliminatedId]) {
        game.players[eliminatedId].alive = false;
        io.to(safeRoom).emit("playerEliminated", {
          playerId: eliminatedId,
          name: game.players[eliminatedId].name,
          role: game.players[eliminatedId].role,
        });
        console.log(
          `Day elimination in ${safeRoom}: ${game.players[eliminatedId].name} (${game.players[eliminatedId].role})`
        );
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
        console.log(
          `Player disconnected: ${game.players[socket.id].name} from ${roomId}`
        );
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
          console.log(`Deleted empty room ${roomId}`);
        }
      }
    }
  });
});

// ------------------ Start Server ------------------ //
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));