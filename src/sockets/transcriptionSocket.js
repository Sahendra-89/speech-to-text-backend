const prisma = require("../config/database");

/**
 * Socket.IO Real-time Audio Streaming & Transcription Handler
 *
 * Implements incremental audio chunk buffering, proxy to Whisper AI Service,
 * and duplicate-text prevention.
 */

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";

// Helper to compute delta words between previous and current text
function computeTextDelta(previousText, currentText) {
  if (!currentText || !currentText.trim()) return "";
  if (!previousText || !previousText.trim()) return currentText.trim();

  const prev = previousText.trim();
  const curr = currentText.trim();

  if (curr === prev) return "";

  // Direct prefix match: curr begins with prev
  if (curr.startsWith(prev)) {
    return curr.slice(prev.length).trim();
  }

  // Word-level overlap comparison
  const prevWords = prev.split(/\s+/);
  const currWords = curr.split(/\s+/);

  let overlap = 0;
  const maxCheck = Math.min(prevWords.length, currWords.length);

  for (let len = maxCheck; len > 0; len--) {
    const prevSlice = prevWords.slice(prevWords.length - len).join(" ");
    const currSlice = currWords.slice(0, len).join(" ");
    if (prevSlice.toLowerCase() === currSlice.toLowerCase()) {
      overlap = len;
      break;
    }
  }

  const deltaWords = currWords.slice(overlap);
  return deltaWords.join(" ");
}

const initTranscriptionSocket = (io) => {
  io.on("connection", (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Session state for this connection
    const session = {
      active: false,
      title: "Live Transcription",
      language: null,
      format: "webm",
      chunks: [],
      startTime: null,
      lastEmittedText: "",
      fullText: "",
      isProcessing: false,
      hasPending: false,
    };

    // Client starts real-time session
    socket.on("start_transcription", (data = {}) => {
      session.active = true;
      session.title = data.title || "Live Transcription";
      let reqLang = data.language;
      if (typeof reqLang === "string") {
        const trimmed = reqLang.trim().toLowerCase();
        reqLang = trimmed && !["auto", "none", "null", "undefined"].includes(trimmed) ? trimmed : null;
      } else {
        reqLang = null;
      }
      session.language = reqLang;
      session.format = (data.format || "webm").replace(/^\./, "").toLowerCase();
      session.chunks = [];
      session.startTime = Date.now();
      session.lastEmittedText = "";
      session.fullText = "";
      session.isProcessing = false;
      session.hasPending = false;

      console.log(`[Socket] Started transcription session for ${socket.id} (language: ${session.language || "auto"}, format: ${session.format})`);
      socket.emit("transcription_ready", { status: "ready", socketId: socket.id });
    });

    // Helper to send audio buffer to AI service
    const processBuffer = async (isFinal = false) => {
      if (session.chunks.length === 0 || session.isProcessing) {
        if (session.chunks.length > 0) session.hasPending = true;
        return;
      }

      session.isProcessing = true;
      session.hasPending = false;

      const aiServiceUrl = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";

      try {
        const audioBuffer = Buffer.concat(session.chunks);
        if (audioBuffer.length < 500 && !isFinal) {
          session.isProcessing = false;
          return;
        }

        const filename = `stream.${session.format}`;
        const blob = new Blob([audioBuffer]);
        const formData = new FormData();
        formData.append("file", blob, filename);
        if (session.language) {
          formData.append("language", session.language);
        }

        const aiRes = await fetch(`${aiServiceUrl}/transcribe`, {
          method: "POST",
          body: formData,
        });

        if (aiRes.ok) {
          const aiData = await aiRes.json();
          const currentText = (aiData.text || "").trim();
          session.language = aiData.language || session.language;

          if (currentText) {
            const delta = computeTextDelta(session.lastEmittedText, currentText);

            if (delta || isFinal) {
              session.lastEmittedText = currentText;
              session.fullText = currentText;

              socket.emit("transcription_chunk", {
                text: currentText,
                delta: delta,
                language: session.language,
                languageProbability: aiData.language_probability,
                isFinal: isFinal,
              });
            }
          }
        } else {
          console.error(`[Socket] AI Service error: ${aiRes.status}`);
        }
      } catch (err) {
        console.error("[Socket] Chunk transcription error:", err.message);
      } finally {
        session.isProcessing = false;
        // If more chunks arrived while processing, trigger next batch
        if (session.hasPending && session.active) {
          setImmediate(() => processBuffer(false));
        }
      }
    };

    // Client streams audio chunk (ArrayBuffer, Buffer, or base64)
    socket.on("audio_chunk", (data) => {
      if (!session.active) return;

      let chunkBuffer;
      if (Buffer.isBuffer(data)) {
        chunkBuffer = data;
      } else if (data instanceof ArrayBuffer) {
        chunkBuffer = Buffer.from(data);
      } else if (typeof data === "string") {
        chunkBuffer = Buffer.from(data, "base64");
      } else if (data?.chunk) {
        chunkBuffer = Buffer.isBuffer(data.chunk)
          ? data.chunk
          : Buffer.from(data.chunk, typeof data.chunk === "string" ? "base64" : undefined);
      }

      if (chunkBuffer && chunkBuffer.length > 0) {
        session.chunks.push(chunkBuffer);

        // Process incrementally when buffer reaches reasonable size (~3s)
        const totalBytes = session.chunks.reduce((acc, c) => acc + c.length, 0);
        if (totalBytes >= 12000 && !session.isProcessing) {
          processBuffer(false);
        }
      }
    });

    // Client stops real-time session
    socket.on("stop_transcription", async (data = {}) => {
      console.log(`[Socket] Stopping transcription session for ${socket.id}`);
      session.active = false;

      // Wait if an intermediate chunk is currently being processed
      while (session.isProcessing) {
        await new Promise((r) => setTimeout(r, 150));
      }

      // Final processing pass with all concatenated audio
      await processBuffer(true);

      // Wait for final pass to complete
      while (session.isProcessing) {
        await new Promise((r) => setTimeout(r, 150));
      }

      const duration = session.startTime ? Math.round((Date.now() - session.startTime) / 1000) : 0;
      const finalText = (session.fullText || session.lastEmittedText || "").trim();

      socket.emit("transcription_complete", {
        text: finalText,
        language: session.language,
        duration: duration,
      });

      // Optionally save to PostgreSQL via Prisma
      if (finalText && finalText.trim()) {
        try {
          const saved = await prisma.transcription.create({
            data: {
              title: data.title || session.title || "Live Transcription",
              text: finalText,
              language: session.language,
              duration: duration,
            },
          });
          socket.emit("transcription_saved", {
            success: true,
            data: saved,
          });
        } catch (dbErr) {
          console.warn("[Socket] Could not persist transcription to database:", dbErr.message);
          socket.emit("transcription_saved", {
            success: false,
            message: "Transcription complete, but could not save to DB (database offline)",
          });
        }
      }

      // Reset chunks
      session.chunks = [];
    });

    socket.on("disconnect", () => {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
      session.active = false;
      session.chunks = [];
    });
  });
};

module.exports = initTranscriptionSocket;
