const express = require("express");
const router = express.Router();

const controller = require("../controllers/transcriptionController");

// Audio transcription proxy endpoint
router.post("/transcribe", controller.transcribeAudio);

// Existing CRUD endpoints
router.post("/", controller.createTranscription);
router.get("/", controller.getAllTranscriptions);
router.get("/:id", controller.getTranscriptionById);
router.put("/:id", controller.updateTranscription);
router.delete("/:id", controller.deleteTranscription);

module.exports = router;
