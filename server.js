const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const games = {}; // store game rooms

io.on("connection", (socket) => {
  console.log("New client:", socket.id);

  socket.on("createRoom", ({ roomId, name }) => {
    if (!games[roomId]) {
      games[roomId] = { players: {}, status: "waiting" };
    }
    games[roomId].players[socket.id] = { name, role: null, alive: true };
    socket.join(roomId);

    io.to(roomId).emit("lobbyUpdate", games[roomId].players);
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    if (games[roomId]) {
      games[roomId].players[socket.id] = { name, role: null, alive: true };
      socket.join(roomId);

      io.to(roomId).emit("lobbyUpdate", games[roomId].players);
    } else {
      socket.emit("errorMsg", "Room not found");
    }
  });

  socket.on("disconnect", () => {
    for (const roomId in games) {
      if (games[roomId].players[socket.id]) {
        delete games[roomId].players[socket.id];
        io.to(roomId).emit("lobbyUpdate", games[roomId].players);
      }
    }
  });
});

server.listen(4000, () => {
  console.log("Server running on http://localhost:4000");
});