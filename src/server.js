require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const transcriptionRoutes = require("./routes/transcriptionRoutes");
const initTranscriptionSocket = require("./sockets/transcriptionSocket");

const app = express();
const server = http.createServer(app);

// Allow all origins dynamically (supporting Vercel, localhost, previews)
const corsOptions = {
  origin: (origin, callback) => {
    callback(null, true);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
};

// Initialize Socket.io
const io = new Server(server, {
  cors: corsOptions,
  transports: ["polling", "websocket"],
});

// Middlewares
app.use(cors(corsOptions));
app.use(express.raw({ type: ["audio/*", "application/octet-stream"], limit: "50mb" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", message: "SpeechFlow Backend Running" });
});

// API Routes
app.use("/api/transcriptions", transcriptionRoutes);

// Socket setup
initTranscriptionSocket(io);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
