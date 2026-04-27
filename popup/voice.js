// =============================================================================
// Beacon — Voice layer (Workstream D)
// Web Speech API (STT) + ElevenLabs multilingual TTS
// =============================================================================

/** @typedef {'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING'} VoiceState */

const SpeechRecognitionCtor =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

/** BCP-47 tags for supported UI languages */
export const LANGUAGE_CODES = {
  English: "en-US",
  Hindi: "hi-IN",
  Spanish: "es-ES",
  Telugu: "te-IN",
  French: "fr-FR",
  Mandarin: "zh-CN",
  Arabic: "ar-SA",
  Portuguese: "pt-BR",
  German: "de-DE",
};

/** Multilingual voice (Adam) — eleven_multilingual_v2 adapts per language */
const DEFAULT_MULTILINGUAL_VOICE = "pNInz6obpgDQGcFmaJgB";

const VOICE_MAP = {
  "en-US": "21m00Tcm4TlvDq8ikWAM",
  "hi-IN": DEFAULT_MULTILINGUAL_VOICE,
  "es-ES": DEFAULT_MULTILINGUAL_VOICE,
  "te-IN": DEFAULT_MULTILINGUAL_VOICE,
  "fr-FR": DEFAULT_MULTILINGUAL_VOICE,
  "zh-CN": DEFAULT_MULTILINGUAL_VOICE,
  "ar-SA": DEFAULT_MULTILINGUAL_VOICE,
  "pt-BR": DEFAULT_MULTILINGUAL_VOICE,
  "de-DE": DEFAULT_MULTILINGUAL_VOICE,
};

/** @type {VoiceState} */
let currentState = "IDLE";

/** @type {SpeechRecognition | null} */
let recognition = null;

/** When true, recognition `onend` must not flush transcript (Escape / cancel). */
let listenCancelled = false;

/** @type {string} */
let pendingTranscript = "";

/** @type {HTMLAudioElement | null} */
let currentAudio = null;

/** @type {string | null} */
let currentAudioObjectUrl = null;

/** @type {((state: VoiceState) => void) | null} */
let onStateChange = null;

/** @type {((text: string) => void) | null} */
let onTranscript = null;

/** @type {((text: string) => void | Promise<void>) | null} */
let onFinalTranscript = null;

/**
 * @param {{ onStateChange?: (s: VoiceState) => void; onTranscript?: (t: string) => void; onFinalTranscript?: (t: string) => void | Promise<void> }} handlers
 */
export function setVoiceHandlers(handlers) {
  if (handlers.onStateChange) onStateChange = handlers.onStateChange;
  if (handlers.onTranscript) onTranscript = handlers.onTranscript;
  if (handlers.onFinalTranscript) onFinalTranscript = handlers.onFinalTranscript;
}

function setState(next) {
  if (currentState === next) return;
  currentState = next;
  try {
    onStateChange?.(next);
  } catch (e) {
    console.error("[Beacon Voice] onStateChange error:", e);
  }
}

export function getCurrentState() {
  return currentState;
}

/**
 * Popup should call when starting an AI request (e.g. after final STT), before await sendMessage.
 */
export function enterProcessing() {
  if (currentState === "LISTENING") return;
  setState("PROCESSING");
}

/**
 * Call when AI request finished and you are not about to speak (or let speak() transition).
 */
export function exitProcessing() {
  if (currentState !== "PROCESSING") return;
  setState("IDLE");
}

async function getSetting(key) {
  const obj = await chrome.storage.local.get(key);
  return obj[key];
}

function getVoiceIdForLanguage(language) {
  return VOICE_MAP[language] || DEFAULT_MULTILINGUAL_VOICE;
}

export function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio = null;
  }
  if (currentAudioObjectUrl) {
    URL.revokeObjectURL(currentAudioObjectUrl);
    currentAudioObjectUrl = null;
  }
  if (currentState === "SPEAKING") setState("IDLE");
}

/**
 * @param {string} text
 * @param {string} language BCP-47 e.g. en-US
 * @returns {Promise<void>}
 */
export async function speak(text, language) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;

  stopSpeaking();

  const apiKey =
    (await getSetting("elevenLabsApiKey")) ||
    (await getSetting("elevenLabsKey"));
  if (!apiKey) {
    console.warn("[Beacon Voice] Missing ElevenLabs API key in chrome.storage.local");
    setState("IDLE");
    throw new Error("ElevenLabs API key not configured");
  }

  const voiceId = getVoiceIdForLanguage(language);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: trimmed,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
  } catch (err) {
    console.error("[Beacon Voice] TTS fetch failed:", err);
    setState("IDLE");
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText);
    console.error("[Beacon Voice] TTS API error:", response.status, errText);
    setState("IDLE");
    throw new Error(`ElevenLabs TTS failed: ${response.status}`);
  }

  const audioBlob = await response.blob();
  const audioUrl = URL.createObjectURL(audioBlob);
  currentAudioObjectUrl = audioUrl;

  const audio = new Audio(audioUrl);
  currentAudio = audio;

  setState("SPEAKING");

  return new Promise((resolve, reject) => {
    audio.onended = () => {
      stopSpeaking();
      resolve();
    };
    audio.onerror = () => {
      stopSpeaking();
      reject(new Error("Audio playback error"));
    };
    audio.play().catch((e) => {
      stopSpeaking();
      reject(e);
    });
  });
}

function flushFinalTranscript() {
  const text = pendingTranscript.trim();
  pendingTranscript = "";
  const handler = onFinalTranscript;
  if (!handler) return;
  try {
    const out = handler(text);
    if (out && typeof out.then === "function") out.catch((e) => console.error("[Beacon Voice] onFinalTranscript:", e));
  } catch (e) {
    console.error("[Beacon Voice] onFinalTranscript:", e);
  }
}

/**
 * @param {string} languageCode e.g. hi-IN
 */
export function startListening(languageCode) {
  if (!SpeechRecognitionCtor) {
    console.error("[Beacon Voice] Web Speech API not available");
    setState("IDLE");
    return;
  }

  listenCancelled = false;

  if (currentState === "SPEAKING") stopSpeaking();
  if (recognition) {
    try {
      recognition.abort();
    } catch (_) {
      /* ignore */
    }
    recognition = null;
  }

  pendingTranscript = "";

  const instance = new SpeechRecognitionCtor();
  recognition = instance;
  instance.continuous = true;
  instance.interimResults = true;
  instance.lang = languageCode;

  instance.onresult = (event) => {
    if (recognition !== instance) return;
    const transcript = Array.from(event.results)
      .map((r) => r[0]?.transcript ?? "")
      .join("");
    pendingTranscript = transcript;
    try {
      onTranscript?.(transcript);
    } catch (e) {
      console.error("[Beacon Voice] onTranscript:", e);
    }
  };

  instance.onerror = (e) => {
    console.error("[Beacon Voice] recognition error:", e.error);
    if (e.error === "aborted" || e.error === "no-speech") {
      return;
    }
    if (recognition === instance) setState("IDLE");
  };

  instance.onend = () => {
    if (recognition !== instance) return;
    recognition = null;
    if (currentState === "LISTENING") {
      if (listenCancelled) {
        listenCancelled = false;
        pendingTranscript = "";
        setState("IDLE");
        return;
      }
      setState("IDLE");
      flushFinalTranscript();
    }
  };

  try {
    instance.start();
    setState("LISTENING");
  } catch (err) {
    console.error("[Beacon Voice] recognition.start failed:", err);
    recognition = null;
    setState("IDLE");
  }
}

export function stopListening() {
  if (!recognition) {
    if (currentState === "LISTENING") setState("IDLE");
    return;
  }
  const inst = recognition;
  try {
    inst.stop();
  } catch (err) {
    console.error("[Beacon Voice] recognition.stop failed:", err);
    if (recognition === inst) recognition = null;
    setState("IDLE");
  }
}

/** Cancel STT without firing onFinalTranscript (e.g. Escape). */
export function abortListening() {
  listenCancelled = true;
  pendingTranscript = "";
  if (!recognition) {
    listenCancelled = false;
    if (currentState === "LISTENING") setState("IDLE");
    return;
  }
  const inst = recognition;
  try {
    inst.abort();
  } catch (err) {
    console.error("[Beacon Voice] recognition.abort failed:", err);
    if (recognition === inst) recognition = null;
    listenCancelled = false;
    setState("IDLE");
  }
}
