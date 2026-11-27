
const prisma = require("../config/database");

// 1. CREATE TRANSCRIPTION
exports.createTranscription = async (req, res) => {
  try {
    const { title, text, language, duration } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: "Transcription text is required"
      });
    }

    const transcription = await prisma.transcription.create({
      data: {
        title,
        text,
        language,
        duration: duration || 0
      }
    });

    res.status(201).json({
      success: true,
      message: "Transcription created successfully",
      data: transcription
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to create transcription"
    });
  }
};


// 2. GET ALL TRANSCRIPTIONS
exports.getAllTranscriptions = async (req, res) => {
  try {
    const transcriptions = await prisma.transcription.findMany({
      orderBy: {
        createdAt: "desc"
      }
    });

    res.status(200).json({
      success: true,
      count: transcriptions.length,
      data: transcriptions
    });

  } catch (error) {
    console.error("Error in getAllTranscriptions:", error.message || error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch transcriptions: " + (error.message || "Internal Server Error")
    });
  }
};


// 3. GET TRANSCRIPTION BY ID
exports.getTranscriptionById = async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid transcription ID"
      });
    }

    const transcription = await prisma.transcription.findUnique({
      where: { id }
    });

    if (!transcription) {
      return res.status(404).json({
        success: false,
        message: "Transcription not found"
      });
    }

    res.status(200).json({
      success: true,
      data: transcription
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch transcription"
    });
  }
};


// 4. UPDATE TRANSCRIPTION
exports.updateTranscription = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { title, text } = req.body;

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid transcription ID"
      });
    }

    if (text !== undefined && (typeof text !== "string" || !text.trim())) {
      return res.status(400).json({
        success: false,
        message: "Transcription text cannot be empty"
      });
    }

    const transcription = await prisma.transcription.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(text !== undefined && { text })
      }
    });

    res.status(200).json({
      success: true,
      message: "Transcription updated successfully",
      data: transcription
    });

  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({
        success: false,
        message: "Transcription not found"
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to update transcription"
    });
  }
};


// 5. DELETE TRANSCRIPTION
exports.deleteTranscription = async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid transcription ID"
      });
    }

    await prisma.transcription.delete({
      where: { id }
    });

    res.status(200).json({
      success: true,
      message: "Transcription deleted successfully"
    });

  } catch (error) {
    if (error.code === "P2025") {
      return res.status(404).json({
        success: false,
        message: "Transcription not found"
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to delete transcription"
    });
  }
};


// 6. PROXY AUDIO TRANSCRIPTION TO AI SERVICE & SAVE TO POSTGRESQL
const SUPPORTED_AUDIO_EXTENSIONS = new Set(["wav", "mp3", "m4a", "webm", "ogg", "flac", "aac"]);
const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB limit

exports.transcribeAudio = async (req, res) => {
  try {
    const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
    let audioBuffer;
    let format = "wav";
    let title = req.body?.title || null;
    let duration = Number(req.body?.duration) || 0;

    // Sanitize language parameter: ignore 'auto', 'null', empty strings
    let rawLang = req.body?.language;
    let language = null;
    if (rawLang && typeof rawLang === "string") {
      const trimmed = rawLang.trim().toLowerCase();
      if (trimmed && !["auto", "none", "null", "undefined"].includes(trimmed)) {
        language = trimmed;
      }
    }

    if (req.body?.audioBase64) {
      if (typeof req.body.audioBase64 !== "string" || !req.body.audioBase64.trim()) {
        return res.status(400).json({
          success: false,
          message: "Uploaded audio data is empty"
        });
      }
      audioBuffer = Buffer.from(req.body.audioBase64, "base64");
      format = (req.body.format || "wav").replace(/^\./, "").toLowerCase();
    } else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      audioBuffer = req.body;
      const contentType = req.headers["content-type"] || "audio/wav";
      format = (contentType.split("/")[1] || "wav").toLowerCase();
    } else {
      return res.status(400).json({
        success: false,
        message: "No audio data provided. Please provide 'audioBase64' or binary audio."
      });
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Uploaded audio file is empty"
      });
    }

    if (audioBuffer.length > MAX_AUDIO_SIZE) {
      return res.status(400).json({
        success: false,
        message: `Audio file exceeds maximum allowed size of 25MB (Received: ${(audioBuffer.length / (1024 * 1024)).toFixed(2)}MB)`
      });
    }

    if (!SUPPORTED_AUDIO_EXTENSIONS.has(format)) {
      return res.status(400).json({
        success: false,
        message: `Unsupported audio format '${format}'. Supported: ${Array.from(SUPPORTED_AUDIO_EXTENSIONS).join(", ")}`
      });
    }

    const filename = `audio.${format}`;
    const blob = new Blob([audioBuffer]);
    const formData = new FormData();
    formData.append("file", blob, filename);
    if (language) {
      formData.append("language", language);
    }

    let aiResponse;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000); // 180s timeout

      aiResponse = await fetch(`${AI_SERVICE_URL}/transcribe`, {
        method: "POST",
        body: formData,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
    } catch (networkError) {
      console.error("AI service connection error:", networkError.message);
      if (networkError.name === "AbortError") {
        return res.status(504).json({
          success: false,
          message: "AI service request timed out after 180 seconds."
        });
      }
      return res.status(503).json({
        success: false,
        message: "AI Transcription Service is currently unavailable. Please ensure the Python service is running on " + AI_SERVICE_URL
      });
    }

    if (!aiResponse.ok) {
      let errorDetail = "AI Service Error";
      try {
        const errorJson = await aiResponse.json();
        errorDetail = errorJson.detail || JSON.stringify(errorJson);
      } catch {
        errorDetail = await aiResponse.text();
      }
      return res.status(aiResponse.status).json({
        success: false,
        message: `AI service returned error: ${errorDetail}`
      });
    }

    const aiData = await aiResponse.json();
    const transcribedText = (aiData.text || "").trim();

    // STEP 3: Save successful transcription results into PostgreSQL using Prisma
    // Do not save incomplete or failed transcriptions
    let savedRecord = null;
    if (transcribedText) {
      try {
        savedRecord = await prisma.transcription.create({
          data: {
            title: title || (format ? `Recording (${format.toUpperCase()})` : "Audio Recording"),
            text: transcribedText,
            language: aiData.language || language || null,
            duration: Math.round(duration)
          }
        });
      } catch (dbError) {
        console.error("Database save failed during transcription:", dbError.message);
        // Continue returning the transcription even if DB persistence encounters an issue
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        text: transcribedText,
        language: aiData.language,
        language_probability: aiData.language_probability,
        savedRecord: savedRecord
      }
    });

  } catch (error) {
    console.error("Transcription processing failed:", error);
    return res.status(500).json({
      success: false,
      message: `Failed to process audio transcription: ${error.message}`
    });
  }
};
