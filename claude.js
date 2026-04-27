// =============================================================================
// Netra - Claude Vision Integration  (Workstream B)
// =============================================================================
// Exports one primary function:
//   askBeacon(transcript, language, screenshotBase64, tabId)
//     → { text: string, points: Array, draws: Array }
//
// Call chain:
//   background.js  →  askBeacon()  →  Claude API  →  tag parser  →  return
//
// >>> WORKSTREAM F PLUG-IN POINT <<<
// Replace ANTHROPIC_API_URL with WORKER_URL once the Cloudflare proxy is live.
// The proxy should accept the same request body and forward it with the real
// API key stored server-side, so the key is never exposed to the extension.
//   const WORKER_URL = "https://beacon-proxy.YOUR_SUBDOMAIN.workers.dev";
// =============================================================================

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL             = "claude-haiku-4-5-20251001";
const MAX_TOKENS        = 1024;

// Frozen so callers can't accidentally mutate the shared fallback.
const FALLBACK_RESPONSE = Object.freeze({
  text:   "I can see your screen but had trouble analyzing it. Please try again.",
  points: Object.freeze([]),
  draws:  Object.freeze([])
});

/**
 * Tuning for "mechanical" translations: many locales read stiff by default; Hindi
 * especially trends formal / Sanskrit-heavy without explicit spoken-register hints.
 * @param {string} [language] BCP-47 tag, e.g. hi-IN
 * @returns {string}
 */
function getLocaleStyleHint(language) {
  const tag = (language || "").toLowerCase().trim();
  if (tag.startsWith("hi")) {
    return `Language (Hindi): Speak natural बोलचाल Hindi — the way you'd help a friend on a phone call. Use Hinglish freely for UI words (button, sign in, link, scroll). Avoid stiff textbook Hindi or "news reader" phrasing. Keep sentences short and warm. Example: "अच्छा, ये वाला button दबाओ" not "कृपया इस बटन पर क्लिक करें।"`;
  }
  if (tag.startsWith("zh")) {
    return `Language (Chinese): Speak natural conversational Chinese, like texting a friend. Short sentences, casual tone.`;
  }
  if (tag.startsWith("es")) {
    return `Language (Spanish): Speak warm, casual Spanish — like helping a friend. Use "tú" form, contractions, and natural phrasing.`;
  }
  return `Language: Speak like you're helping a friend over a call — casual, warm, and brief.`;
}

/**
 * @param {string} transcript
 * @param {string} [language]
 * @param {{ imageWidth: number, imageHeight: number, cssWidth: number, cssHeight: number } | null | undefined} [screenMeta]
 * @param {Array | null | undefined} [domContext]
 * @returns {string}
 */
function buildUserMessageText(transcript, language, screenMeta, domContext) {
  const tag = (language || "").toLowerCase().trim();
  const extra = tag.startsWith("hi")
    ? " (Answer in natural spoken Hindi / बोलचाल—Hinglish for UI terms is fine.)"
    : "";
  let spatial = "";
  if (
    screenMeta &&
    screenMeta.imageWidth > 0 &&
    screenMeta.imageHeight > 0
  ) {
    spatial = `\n\nSPATIAL (read carefully): The screenshot image is ${screenMeta.imageWidth}×${screenMeta.imageHeight} pixels. The browser viewport is ${screenMeta.cssWidth}×${screenMeta.cssHeight} CSS pixels. For [POINT:x=N y=N] and [DRAW:...] coordinates, use the **screenshot image pixel grid** (0…${screenMeta.imageWidth} horizontally, 0…${screenMeta.imageHeight} vertically), top-left origin—exactly the same pixels you see in the image. For [POINT:selector=...] pick ONE unique element: prefer #id, [data-testid], [aria-label], or a very specific path—never a lone generic tag (e.g. "button", "a") if several exist; use image coordinates in that case.`;
  }
  let domBlock = "";
  if (Array.isArray(domContext) && domContext.length > 0) {
    const lines = domContext.map(
      (el) => `  ${el.tag} | "${el.text}" | selector="${el.selector}" | center=(${el.x},${el.y}) ${el.w}x${el.h}`
    );
    domBlock = `\n\nINTERACTIVE ELEMENTS ON SCREEN (use these selectors for [POINT:selector="..."] when possible):\n${lines.join("\n")}`;
  }
  return `The user asks: ${transcript}${extra}${spatial}${domBlock}\n\nRespond in ${language}.`;
}

// {language} and {localeStyle} are substituted at call time.
const SYSTEM_PROMPT = `You are Netra — a friendly companion that lives as a small dot on the user's browser. You can see their screen and you talk to them out loud.

YOUR OUTPUT WILL BE READ ALOUD BY A TEXT-TO-SPEECH ENGINE. Write EXACTLY how a helpful friend would speak — not how they'd type.

{localeStyle}

Voice style rules (critical):
- Use contractions: "you'll", "it's", "don't", "here's", "that's" — never "you will", "it is", "do not"
- Keep it short: one to two natural sentences max. No walls of text.
- Sound warm: "Okay, so...", "Alright,", "Nice!", "Got it.", "Sure thing."
- No markdown ever: no bold, no italics, no bullet lists, no backticks, no code blocks
- No special characters that sound weird spoken: avoid slashes, pipes, angle brackets, parenthetical asides
- Write numbers as words when short: "three" not "3", "around twenty" not "~20"
- For URLs or technical terms the user asked about, say them naturally: "eleven labs dot io" not "elevenlabs.io"
- Use ellipses for natural pauses: "Hmm... let me see" or "Okay... so click that one"
- Don't start with "I": vary your openings. "Alright", "So", "Okay", "Nice", "Here's the thing", etc.

MANDATORY: Every response MUST include at least one [POINT] tag — no exceptions. Even for general questions, point to the most relevant thing on screen.

Tag syntax:
[POINT:selector="button.submit-btn" label="Click this button"]
[POINT:x=450 y=320 label="Click here"]
[DRAW:type="rect" x1=100 y1=200 x2=300 y2=400 color="#20b8cd" label="This area"]

For diagrams (when they say "draw", "visualize", "show me"):
[DRAW:type="node" x=260 y=220 label="Root"]
[DRAW:type="arrow" fromX=260 fromY=240 toX=180 toY=280 label="left"]

AUTO-FOLLOW: When the message starts with "I clicked", they just did what you said. Glance at the new screenshot, acknowledge briefly ("Nice, that worked" or "Okay, good"), then tell them the next thing. Keep the momentum going — one short sentence, one POINT.

When INTERACTIVE ELEMENTS are listed, use those exact selectors — they're real CSS from the live page.

Rules:
- Always include at least one [POINT] tag
- One to two spoken sentences max — you're a guide, not a lecturer
- Prefer unique CSS selectors (id, data-testid, aria-label) over generic ones; use coordinates if nothing unique exists
- [POINT] / [DRAW] coordinates use screenshot image pixel space (stated in the user message)
- Respond in {language}`;

// =============================================================================
// Public API
// =============================================================================

/**
 * Ask Claude to analyse a screenshot and respond to the user's query.
 *
 * @param {string} transcript       - User's spoken/typed question
 * @param {string} language         - BCP-47 language code, e.g. "en-US"
 * @param {string} screenshotBase64 - Full data URL ("data:image/png;base64,...")
 *                                    OR raw base64 string — both are handled.
 * @param {number} tabId            - Active tab ID (passed through for context;
 *                                    actual sendMessage is done in background.js)
 * @param {Array<{role: string, content: string}>} [conversationHistory] - prior turns
 * @param {{ imageWidth: number, imageHeight: number, cssWidth: number, cssHeight: number } | null} [screenMeta] - for spatial calibration
 * @param {string | null | undefined} [currentUrl] - active tab URL
 * @param {Array | null | undefined} [domContext] - interactive element descriptors from content script
 * @returns {Promise<{text: string, points: Array, draws: Array}>}
 */
export async function askBeacon(
  transcript,
  language,
  screenshotBase64,
  tabId,
  conversationHistory,
  screenMeta,
  currentUrl,
  domContext
) {
  try {
    // ------------------------------------------------------------------
    // Route 1: Cloudflare Worker proxy (preferred — key stays server-side)
    // Store the deployed worker URL via:
    //   chrome.storage.local.set({ workerUrl: "https://beacon-proxy.XYZ.workers.dev" })
    // ------------------------------------------------------------------
    const workerUrl = await getWorkerUrl();
    console.log("[Netra Claude] Worker URL from storage:", workerUrl ?? "(none — will use direct API)");

    // Only send to the worker (which has Exa tools) when the query explicitly
    // signals a web search / fact-check need. Navigation and UI questions go
    // straight to the direct streaming API — faster and no unnecessary tool calls.
    if (workerUrl && needsWebSearch(transcript)) {
      try {
        console.log("[Netra Claude] Query needs web search — routing to worker");
        return await askViaWorker(
          transcript,
          language,
          screenshotBase64,
          workerUrl,
          conversationHistory,
          screenMeta,
          currentUrl
        );
      } catch (networkErr) {
        console.warn("[Netra Claude] Worker network error, falling back to direct API:", networkErr.message);
      }
    } else if (workerUrl) {
      console.log("[Netra Claude] Navigation/UI query — using direct API (no Exa)");
    }

    // ------------------------------------------------------------------
    // Route 2: Direct Anthropic API (fallback — requires anthropicKey in storage)
    // ------------------------------------------------------------------
    const apiKey = await getApiKey();
    if (!apiKey) {
      console.error("[Netra Claude] No API key found. Store it with: storeSetting 'anthropicKey'");
      return {
        text:   "Please add your Anthropic API key in the extension settings to enable AI guidance.",
        points: [],
        draws:  []
      };
    }

    const { mediaType, data } = stripDataUrl(screenshotBase64);

    const systemPrompt = SYSTEM_PROMPT.replace("{language}", language)
      .replace("{localeStyle}", getLocaleStyleHint(language));

    const userText = buildUserMessageText(
      transcript,
      language,
      screenMeta,
      domContext
    );

    const historyMessages = normalizeConversationHistory(conversationHistory);

    console.log("[Netra Claude] Streaming request to Claude:", {
      model: MODEL,
      transcriptLength: transcript?.length,
      language,
      historyTurns: historyMessages.length,
      screenshotKB: Math.round(data.length / 1024 * 0.75)
    });

    const response = await fetch(ANTHROPIC_API_URL, {
      method:  "POST",
      headers: {
        "Content-Type":                              "application/json",
        "x-api-key":                                 apiKey,
        "anthropic-version":                         "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        stream:     true,           // enable SSE streaming
        system:     systemPrompt,
        messages: [
          ...historyMessages,
          {
            role: "user",
            content: [
              {
                type:   "image",
                source: { type: "base64", media_type: mediaType, data }
              },
              {
                type: "text",
                text: userText
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "(unreadable)");
      console.error(`[Netra Claude] API error ${response.status}:`, errText);
      return FALLBACK_RESPONSE;
    }

    // Consume the SSE stream, sending spatial tags to content.js as they arrive.
    // Returns { text, points, draws } once the stream is fully consumed.
    return await consumeStream(response.body, tabId);

  } catch (err) {
    console.error("[Netra Claude] askBeacon failed:", err);
    return FALLBACK_RESPONSE;
  }
}

// -----------------------------------------------------------------------------
// needsWebSearch
// Lightweight keyword check on the transcript to decide whether to call the
// Cloudflare Worker (which has Exa tools) or go straight to Claude streaming.
// False positives are OK — they just add a tiny Exa round-trip.
// False negatives waste latency on navigation questions that could answer instantly.
// -----------------------------------------------------------------------------
function needsWebSearch(transcript) {
  const t = (transcript || "").toLowerCase();
  // Explicit search/fact-check signals
  const searchSignals = [
    "fact check", "fact-check", "is this true", "is this real", "is this fake",
    "verify", "is it true", "are they giving", "is the government",
    "current price", "latest news", "today's", "breaking news",
    "explain this page", "summarize this", "what does this page",
    "find similar", "alternatives to", "are there alternatives",
    "research", "tell me about", "who is", "what is the latest",
    "is this legitimate", "is this scam", "check this"
  ];
  return searchSignals.some((s) => t.includes(s));
}

// -----------------------------------------------------------------------------
// askViaWorker
// Calls the Cloudflare Worker /chat endpoint. The worker holds the Anthropic
// key server-side and returns already-parsed { text, points, draws }.
//
// Worker point type uses "coords" for coordinate points; we normalise to
// "coordinate" here so content.js resolvePointTarget() handles both routes.
// -----------------------------------------------------------------------------
function normalizeConversationHistory(conversationHistory) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
    return [];
  }
  const out = [];
  for (const item of conversationHistory) {
    if (!item || typeof item !== "object") continue;
    const role = item.role;
    const content = item.content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || !content.length) continue;
    out.push({ role, content });
  }
  return out;
}

async function askViaWorker(
  transcript,
  language,
  screenshotBase64,
  workerUrl,
  conversationHistory,
  screenMeta,
  currentUrl
) {
  const { mediaType, data } = stripDataUrl(screenshotBase64);
  const base = workerUrl.replace(/\/+$/, "");
  const history = normalizeConversationHistory(conversationHistory);
  // Sanitize URL before passing to worker. Chrome extension tabs can be
  // chrome://, chrome-extension://, or undefined; Exa only accepts web URLs.
  const safeUrl = currentUrl?.startsWith("http") ? currentUrl : null;

  console.log(`[Netra Claude] Calling worker at ${base}/chat`);

  let response;
  try {
    const body = {
      screenshot:          data,
      screenshotMediaType: mediaType,
      transcript:          transcript || "",
      language,
      conversationHistory: history,
      currentUrl: safeUrl,
    };
    if (screenMeta && screenMeta.imageWidth > 0 && screenMeta.imageHeight > 0) {
      body.screenMeta = screenMeta;
    }
    response = await fetch(`${base}/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    // Re-throw so askBeacon can fall back to direct API on network failures.
    console.error("[Netra Claude] Worker network error (will try direct API):", err.message);
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "(unreadable)");
    console.error(`[Netra Claude] Worker returned ${response.status} — body:`, errText);
    return FALLBACK_RESPONSE;
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    console.error("[Netra Claude] Worker returned invalid JSON:", err);
    return FALLBACK_RESPONSE;
  }

  // Normalise point types: worker emits type:"coords", content.js expects "coordinate"
  const points = (Array.isArray(json.points) ? json.points : []).map((p) =>
    p?.type === "coords" ? { ...p, type: "coordinate" } : p
  );
  const draws = Array.isArray(json.draws) ? json.draws : [];
  const text  = typeof json.text === "string" ? json.text : "";

  console.log("[Netra Claude] Worker response →", { text, points, draws });
  return { text, points, draws };
}

// -----------------------------------------------------------------------------
// consumeStream
// Reads a Claude SSE stream line by line. As each complete [POINT:...] or
// [DRAW:...] tag is detected in the accumulated text, it is immediately
// forwarded to content.js so the cursor can fly WHILE Claude is still typing.
// The final { text, points, draws } is returned once the stream closes —
// background.js then returns the cleaned text to the content script.
// -----------------------------------------------------------------------------
function firstWordsPreview(cleaned, n) {
  const w = String(cleaned)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (w.length === 0) return "";
  return w.slice(0, n).join(" ");
}

async function consumeStream(body, tabId) {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer     = "";   // incomplete line carried between chunks
  let accumulated    = "";   // full response text built up over the stream
  let sentPointCount = 0;    // how many points we've already forwarded
  let sentDrawCount  = 0;    // how many draws  we've already forwarded
  let lastStreamPreview = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });

      // Process every complete newline-terminated line in the buffer
      let nl;
      while ((nl = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, nl).trimEnd();
        lineBuffer = lineBuffer.slice(nl + 1);

        // SSE data lines start with "data: "
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;  // end sentinel (not used by Anthropic but safe)

        let event;
        try { event = JSON.parse(payload); } catch { continue; }

        // We only care about incremental text deltas
        if (event.type !== "content_block_delta") continue;
        if (event.delta?.type !== "text_delta")   continue;

        accumulated += event.delta.text;

        // Live preview: first 5 words of cleaned text (for the companion dot)
        if (tabId) {
          const cleanedSoFar = cleanText(accumulated);
          const preview = firstWordsPreview(cleanedSoFar, 5);
          if (preview && preview !== lastStreamPreview) {
            lastStreamPreview = preview;
            chrome.tabs
              .sendMessage(tabId, { action: "beaconStreamText", text: preview })
              .catch(() => {});
          }
        }

        // Re-parse accumulated text for newly completed spatial tags.
        // parsePoints/parseDraws are cheap and quote-aware.
        const currentPoints = parsePoints(accumulated);
        const currentDraws  = parseDraws(accumulated);

        if (currentPoints.length > sentPointCount || currentDraws.length > sentDrawCount) {
          sentPointCount = currentPoints.length;
          sentDrawCount  = currentDraws.length;

          // Fire-and-forget: send all tags found so far with empty text.
          // content.js renders the cursor/draws immediately.
          // TTS is NOT triggered here (text: "").
          if (tabId) {
            chrome.tabs.sendMessage(tabId, {
              action: "beaconResponse",
              text:   "",
              points: currentPoints,
              draws:  currentDraws
            }).catch(() => {});
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const points = parsePoints(accumulated);
  const draws  = parseDraws(accumulated);
  const text   = cleanText(accumulated);

  console.log("[Netra Claude] Stream complete →", { text, points, draws });
  return { text, points, draws };
}

// =============================================================================
// Tag Parsing Engine
// =============================================================================

/**
 * Parse all [POINT:...] tags from Claude's response.
 *
 * Supports two forms:
 *   [POINT:selector="css.selector" label="..."]   → type: "selector"
 *   [POINT:x=450 y=320 label="..."]               → type: "coordinate"
 *
 * @param {string} text - Raw Claude response text
 * @returns {Array<{type: "selector"|"coordinate", selector?: string,
 *                  x?: number, y?: number, label: string}>}
 */
export function parsePoints(text) {
  const results = [];
  // Quote-aware tag regex: alternates between non-bracket/non-quote chars and
  // double-quoted strings, so ] inside "input[aria-label='X']" is not mistaken
  // for the closing bracket of the POINT tag itself.
  const tagRegex = /\[POINT:((?:[^\]"]*|"[^"]*")*)\]/g;
  let match;

  while ((match = tagRegex.exec(text)) !== null) {
    const attrs = parseAttrs(match[1]);

    if (attrs.selector) {
      results.push({
        type:     "selector",
        selector: attrs.selector,
        label:    attrs.label || ""
      });
    } else if (attrs.x !== undefined && attrs.y !== undefined) {
      results.push({
        type:  "coordinate",
        x:     Number(attrs.x),
        y:     Number(attrs.y),
        label: attrs.label || ""
      });
    } else {
      // Malformed tag — log and skip
      console.warn("[Netra Claude] Unrecognised POINT tag:", match[0]);
    }
  }

  return results;
}

/**
 * Parse all [DRAW:...] tags from Claude's response.
 *
 * Forms:
 * [DRAW:type="rect" x1=N y1=N x2=N y2=N color="#hex" label="..."]
 * [DRAW:type="node" x=N y=N label="..."]
 * [DRAW:type="arrow" fromX=N fromY=N toX=N toY=N label="..."]
 * Coordinates are pixel values relative to the captured viewport.
 *
 * >>> WORKSTREAM C PLUG-IN POINT <<<
 * Use {x1,y1,x2,y2} to draw a rectangle/ellipse on the overlay canvas.
 * color is a CSS hex string. label can be shown as a tooltip.
 *
 * @param {string} text - Raw Claude response text
 * @returns {Array<{x1: number, y1: number, x2: number, y2: number,
 *                  color: string, label: string}>}
 */
export function parseDraws(text) {
  const results = [];
  // Same quote-aware pattern as parsePoints.
  const tagRegex = /\[DRAW:((?:[^\]"]*|"[^"]*")*)\]/g;
  let match;

  while ((match = tagRegex.exec(text)) !== null) {
    const attrs = parseAttrs(match[1]);

    const type = attrs.type || "";
    if (type === "node" && attrs.x !== undefined && attrs.y !== undefined) {
      results.push({
        type:  "node",
        x:     Number(attrs.x),
        y:     Number(attrs.y),
        color: attrs.color || "#20b8cd",
        label: attrs.label || ""
      });
      continue;
    }
    if (
      type === "arrow" &&
      attrs.fromX !== undefined &&
      attrs.fromY !== undefined &&
      attrs.toX !== undefined &&
      attrs.toY !== undefined
    ) {
      results.push({
        type:  "arrow",
        fromX: Number(attrs.fromX),
        fromY: Number(attrs.fromY),
        toX:   Number(attrs.toX),
        toY:   Number(attrs.toY),
        color: attrs.color || "#20b8cd",
        label: attrs.label || ""
      });
      continue;
    }

    if (attrs.x1 === undefined || attrs.y1 === undefined) {
      console.warn("[Netra Claude] Unrecognised DRAW tag:", match[0]);
      continue;
    }

    results.push({
      type:  "rect",
      x1:    Number(attrs.x1),
      y1:    Number(attrs.y1),
      x2:    Number(attrs.x2 ?? attrs.x1),  // default to point if no x2
      y2:    Number(attrs.y2 ?? attrs.y1),
      color: attrs.color || "#20b8cd",
      label: attrs.label || ""
    });
  }

  return results;
}

/**
 * Strip all [POINT:...] and [DRAW:...] tags from text and collapse whitespace.
 * The result is safe for TTS (text-to-speech) and display.
 *
 * @param {string} text - Raw Claude response text
 * @returns {string}
 */
export function cleanText(text) {
  return text
    // Quote-aware removal: handles selectors like input[aria-label='X'] inside tags
    .replace(/\[(?:POINT|DRAW):(?:[^\]"]*|"[^"]*")*\]/g, "")
    .replace(/\s{2,}/g, " ")   // collapse runs of spaces
    .trim();
}

// =============================================================================
// Private Helpers
// =============================================================================

/**
 * Retrieve the deployed Cloudflare Worker base URL from chrome.storage.local.
 * Key name: "workerUrl"
 * Example: "https://beacon-proxy.xyz.workers.dev"
 *
 * If set, ALL requests go through the worker (API key lives server-side).
 * If not set, falls back to direct Anthropic API with client-side key.
 *
 * @returns {Promise<string|null>}
 */
async function getWorkerUrl() {
  const result = await chrome.storage.local.get("workerUrl");
  const url = typeof result.workerUrl === "string" ? result.workerUrl.trim() : "";
  return url.length > 0 ? url : null;
}

/**
 * Retrieve the Anthropic API key from chrome.storage.local.
 * Key name: "anthropicKey"
 *
 * @returns {Promise<string|undefined>}
 */
async function getApiKey() {
  const result = await chrome.storage.local.get(["anthropicKey", "anthropicApiKey"]);
  return result.anthropicKey || result.anthropicApiKey;
}

/**
 * Split a base64 data URL into its media type and raw base64 data.
 * If the input is already raw base64 (no data: prefix), assume image/png.
 *
 * @param {string} dataUrl - "data:image/png;base64,ABC..." or raw base64
 * @returns {{ mediaType: string, data: string }}
 */
function stripDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/s);
  if (match) {
    return { mediaType: match[1], data: match[2] };
  }
  // Already raw base64
  return { mediaType: "image/png", data: dataUrl };
}

/**
 * Parse a flat attribute string into a key→value object.
 *
 * Handles two forms:
 *   key="quoted value"   (strings, hex colours, CSS selectors)
 *   key=123              (plain integers / floats)
 *
 * Quoted values are extracted first; unquoted numeric values are extracted
 * next and only stored if the key isn't already present (prevents the quoted
 * regex's match range from being re-processed).
 *
 * @param {string} str - e.g. 'selector="a.link" label="Click"'
 * @returns {Object}
 */
function parseAttrs(str) {
  const attrs = {};

  // Pass 1: key="value" — handles strings, CSS selectors, hex colours
  str.replace(/(\w+)="([^"]*)"/g, (_, k, v) => {
    attrs[k] = v;
  });

  // Pass 2: key=number — handles integer/float coordinates (x, y, x1 …)
  str.replace(/(\w+)=(-?\d+(?:\.\d+)?)/g, (_, k, v) => {
    if (!(k in attrs)) attrs[k] = v;  // don't overwrite quoted values
  });

  return attrs;
}
