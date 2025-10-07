const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Create config directory if it doesn't exist
const configDir = path.join(process.cwd(), "config");
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// Default server configuration
const defaultConfig = {
  port: PORT,
  maxname: 20,
  maxmessage: 500,
  slowmode: 1000,
  clientslowmode: 10000,
  spamlimit: 5,
  defname: "Bonzi",
  godword: "ce9eb23b94ea9aa2724ddda2ce761479eeaa79f57016cceecd7582ff5aa8440a",
  kingwords: [],
  lowkingwords: []
};

// Initialize config files safely
function initializeFile(filePath, content) {
  if (!fs.existsSync(filePath)) {
    console.log(`Creating ${filePath}`);
    fs.writeFileSync(filePath, content);
  }
}

initializeFile(path.join(configDir, "server-settings.json"), JSON.stringify(defaultConfig, null, 2));
initializeFile(path.join(configDir, "colors.txt"), "red\nblue\ngreen\nyellow\npurple\norange\npink");
initializeFile(path.join(configDir, "bans.txt"), "");
initializeFile(path.join(configDir, "vpncache.txt"), "");

// Serve static files
app.use(express.static(path.join(__dirname, "client")));

// Basic route
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>BonziWORLD Recreation</title>
        <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #fafafa; }
            h1 { color: #4CAF50; }
            p { color: #333; }
        </style>
    </head>
    <body>
        <h1>BonziWORLD Recreation</h1>
        <p>Server is running on port ${PORT}</p>
        <p>Socket.IO server is active</p>
    </body>
    </html>
  `);
});

// Rooms storage
const rooms = {
  default: {
    users: {},
    name: "default",
    ownerID: "0",
    private: false,
    reg: 0,
    loginCount: 0,
    msgsSent: 0,
    cmdsSent: 0
  }
};

// Socket.IO handling
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("login", (data) => {
    console.log("Login attempt:", data);

    const user = {
      id: socket.id,
      name: data.name || "Bonzi",
      color: data.color || "green",
      room: data.room || "default"
    };

    if (!rooms[user.room]) {
      rooms[user.room] = {
        users: {},
        name: user.room,
        ownerID: socket.id,
        private: true,
        reg: 0,
        loginCount: 0,
        msgsSent: 0,
        cmdsSent: 0
      };
    }

    rooms[user.room].users[socket.id] = user;
    socket.join(user.room);

    socket.to(user.room).emit("user-joined", user);

    socket.emit("login-success", {
      user: user,
      roomUsers: Object.values(rooms[user.room].users)
    });

    console.log(`User ${user.name} joined room ${user.room}`);
  });

  socket.on("message", (data) => {
    const room = Object.keys(rooms).find(roomName => rooms[roomName].users[socket.id]);
    if (room) {
      io.to(room).emit("new-message", {
        user: rooms[room].users[socket.id],
        message: data.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    Object.keys(rooms).forEach(roomName => {
      if (rooms[roomName].users[socket.id]) {
        const user = rooms[roomName].users[socket.id];
        delete rooms[roomName].users[socket.id];
        socket.to(roomName).emit("user-left", user);
      }
    });
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    rooms: Object.keys(rooms).length
  });
});

// Start server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`BonziWORLD Server running on port ${PORT}`);
  console.log(`Config directory: ${configDir}`);
  console.log(`Web interface: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed.");
  });
});
