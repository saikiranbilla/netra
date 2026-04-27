// =============================================================================
// Netra - Background Service Worker
// =============================================================================
// This is the central hub for all message passing in the extension.
//
// Message flow:
//   content.js  ──►  background.js  ──►  content.js  (beaconResponse, stream)
//   (settings page uses chrome.storage directly)
//
// Workstream B (claude.js): handles AI calls inside handleSendToNetra().
// Workstream C will receive the beaconResponse message inside content.js.
// Workstream D can extend handleStoreSetting / handleGetSetting for preferences.
// =============================================================================

import { askBeacon } from './claude.js';

// Open settings in a new tab when the user clicks the toolbar icon
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  const url = chrome.runtime.getURL("popup/settings.html");
  chrome.tabs.create({ url, openerTabId: tab.id });
});

// -----------------------------------------------------------------------------
// ensureContentScript
// Pings content.js before every sendMessage. If the ping fails (receiving end
// does not exist), injects content.js programmatically via scripting API.
// This handles tabs that were open before the extension loaded, or pages where
// the content script declaration didn't fire (e.g. pre-existing tabs).
// -----------------------------------------------------------------------------
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
  } catch (_) {
    // Content script not present — inject it now
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files:  ["rough.js", "content.js"]
      });
      console.log("[Netra BG] Content script injected into tab", tabId);
    } catch (injectErr) {
      console.warn("[Netra BG] Could not inject content script:", injectErr.message);
      // Tell the popup so the user gets a clear message instead of silence
      try {
        await chrome.tabs.sendMessage(tabId, {
          action:  "beaconError",
          message: "Please navigate to a real webpage first (not a chrome:// page)"
        });
      } catch {
        /* content script not available */
      }
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Netra BG] Received message:", message.action, message);

  switch (message.action) {

    case "captureScreen":
      handleCaptureScreen(sender, sendResponse);
      return true; // keep channel open for async response

    case "sendToNetra":
      handleSendToNetra(message, sender, sendResponse);
      return true;

    case "storeSetting":
      handleStoreSetting(message, sendResponse);
      return true;

    case "getSetting":
      handleGetSetting(message, sendResponse);
      return true;

    case "openSettings":
      chrome.tabs.create({ url: chrome.runtime.getURL("popup/settings.html") });
      sendResponse({ success: true });
      return false;

    case "netraDebugLog":
      console.log("[Netra CS]", ...(Array.isArray(message.args) ? message.args : []));
      sendResponse({ success: true });
      return false;

    default:
      console.warn("[Netra BG] Unknown action:", message.action);
      sendResponse({ success: false, error: "Unknown action" });
      return false;
  }
});

// -----------------------------------------------------------------------------
// ElevenLabs TTS over a Port — transfers raw ArrayBuffer (no giant base64 in
// sendMessage, which can fail; SW async sendResponse is also unreliable for MP3s).
// Content tries fetch() first; this is the fallback.
// -----------------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "netraTts") return;
  port.onMessage.addListener((msg) => {
    void (async () => {
      try {
        const { voiceId, ttsBody } = msg;
        if (typeof voiceId !== "string" || !voiceId || !ttsBody) {
          port.postMessage({ ok: false, error: "Invalid TTS request" });
          return;
        }
        const data = await chrome.storage.local.get([
          "elevenLabsApiKey",
          "elevenLabsKey"
        ]);
        const apiKey = data.elevenLabsApiKey || data.elevenLabsKey;
        if (!apiKey) {
          port.postMessage({ ok: false, error: "No ElevenLabs API key" });
          return;
        }
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
          voiceId
        )}/stream`;
        const res = await fetch(url, {
          method:  "POST",
          headers: {
            "xi-api-key":  apiKey,
            "Content-Type": "application/json",
            Accept:         "audio/mpeg"
          },
          body: JSON.stringify(ttsBody)
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText);
          port.postMessage({
            ok:     false,
            status: res.status,
            error:  errText.slice(0, 500)
          });
          return;
        }
        const ab = await res.arrayBuffer();
        port.postMessage({ ok: true, ab }, [ab]);
      } catch (err) {
        console.error("[Netra BG] netraTts port failed:", err);
        port.postMessage({ ok: false, error: String(err?.message || err) });
      }
    })();
  });
});

// -----------------------------------------------------------------------------
// captureScreen
// Captures the visible area of the active tab as a base64 PNG data URL.
//
// Workstream B: the returned screenshot is forwarded to handleSendToNetra()
//               so Claude can analyse the page.
// Workstream C: after capture, we forward the screenshot to content.js so the
//               overlay layer (content.js) can use it if needed.
// -----------------------------------------------------------------------------
async function handleCaptureScreen(sender, sendResponse) {
  try {
    // Get the currently active tab in the focused window
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      sendResponse({ success: false, error: "No active tab found" });
      return;
    }

    // Capture the visible viewport as a JPEG data URL (base64-encoded).
    // JPEG at quality 85 keeps screenshots ~200-400 KB vs 3-5 MB for PNG,
    // well within Claude's 5 MB base64 image limit.
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(
      tab.windowId,
      { format: "jpeg", quality: 85 }
    );

    console.log(
      "[Netra BG] Screenshot captured, size:",
      Math.round(screenshotDataUrl.length / 1024),
      "KB"
    );

    // Ensure content script is alive before forwarding the screenshot.
    await ensureContentScript(tab.id);

    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: "screenshotCaptured",
        screenshot: screenshotDataUrl
      });
    } catch (err) {
      console.warn("[Netra BG] Could not forward screenshotCaptured:", err.message);
    }

    sendResponse({ success: true, screenshot: screenshotDataUrl });

  } catch (err) {
    console.error("[Netra BG] captureScreen failed:", err);
    sendResponse({ success: false, error: err.message });
  }
}

// -----------------------------------------------------------------------------
// sendToNetra
// Entry point for AI processing. Receives transcript, language, and screenshot.
// Calls askBeacon() from claude.js, then fans the result out to:
//   1. content.js  — for Workstream C overlay rendering
//   2. popup.js    — so the popup can show status / trigger TTS
//
// Inputs (from message):
//   transcript  — string, user speech or typed query
//   language    — string, BCP-47 tag e.g. "en-US"
//   screenshot  — string, data URL from captureScreen
//
// Output (sendResponse):
//   { success: true, response: string, points: Array, draws: Array }
// -----------------------------------------------------------------------------
async function handleSendToNetra(message, sender, sendResponse) {
  const { transcript, language, screenshot, conversationHistory, screenMeta, domContext } =
    message;

  console.log("[Netra BG] sendToNetra inputs:", {
    transcriptLength: transcript?.length,
    language,
    screenshotLength: screenshot?.length,
    historyCount:     Array.isArray(conversationHistory) ? conversationHistory.length : 0
  });

  // Prefer the tab that sent the message (content script); fall back to active tab.
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const sourceTab = sender?.tab ?? activeTab;
  const tabId = sourceTab?.id;
  const currentUrl = sourceTab?.url || "";

  // Call the Claude Vision integration (claude.js).
  const result = await askBeacon(
    transcript,
    language,
    screenshot,
    tabId,
    Array.isArray(conversationHistory) ? conversationHistory : [],
    screenMeta && typeof screenMeta === "object" ? screenMeta : null,
    currentUrl,
    Array.isArray(domContext) ? domContext : null
  );
  console.log("[Netra BG] askBeacon result:", {
    textLength: result?.text?.length || 0,
    points: Array.isArray(result?.points) ? result.points.length : 0,
    draws: Array.isArray(result?.draws) ? result.draws.length : 0
  });

  console.log("[Netra BG] sendToNetra sendResponse textLength:", result?.text?.length || 0);
  sendResponse({ success: true, response: result.text, points: result.points, draws: result.draws });

  // Forward visuals after unblocking the original content-script request. Voice
  // starts from sendResponse; overlay rendering should never block TTS.
  if (tabId) {
    void (async () => {
      try {
        await ensureContentScript(tabId);
        console.log("[Netra BG] Forwarding final beaconResponse to tab:", tabId);
        await chrome.tabs.sendMessage(tabId, {
          action: "beaconResponse",
          isFinal: true,
          text:   result.text || "",
          points: result.points,
          draws:  result.draws
        });
        console.log("[Netra BG] Final beaconResponse delivered");
      } catch (err) {
        console.warn("[Netra BG] Could not forward beaconResponse to content.js:", err.message);
      }
    })();
  }
}

// -----------------------------------------------------------------------------
// storeSetting
// Persists a key/value pair to chrome.storage.local.
//
// Workstream D: use this for user preferences (API key, voice language, etc.)
// -----------------------------------------------------------------------------
async function handleStoreSetting(message, sendResponse) {
  const { key, value } = message;
  try {
    await chrome.storage.local.set({ [key]: value });
    console.log("[Netra BG] Stored setting:", key);
    sendResponse({ success: true });
  } catch (err) {
    console.error("[Netra BG] storeSetting failed:", err);
    sendResponse({ success: false, error: err.message });
  }
}

// -----------------------------------------------------------------------------
// getSetting
// Retrieves a value from chrome.storage.local by key.
//
// Workstream D: use this to load saved preferences on startup.
// -----------------------------------------------------------------------------
async function handleGetSetting(message, sendResponse) {
  const { key } = message;
  try {
    const result = await chrome.storage.local.get(key);
    console.log("[Netra BG] Got setting:", key, "=", result[key]);
    sendResponse({ success: true, value: result[key] });
  } catch (err) {
    console.error("[Netra BG] getSetting failed:", err);
    sendResponse({ success: false, error: err.message });
  }
}

