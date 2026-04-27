import {
  exaAnswer,
  exaContents,
  exaResearch,
  exaSearch,
  exaSimilar,
} from "./exa";

export interface Env {
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  EXA_API_KEY: string;
  /** Optional: required for POST /transcribe-token */
  ASSEMBLYAI_API_KEY?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: unknown;
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function withCors(init?: ResponseInit): ResponseInit {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(corsHeaders)) {
    headers.set(k, v);
  }
  return { ...init, headers };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: withCors({ headers: { "Content-Type": "application/json" } }).headers,
  });
}

function errorJson(message: string, status: number, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, status);
}

/** Selector-based point from Beacon tags */
export type PointSelector = {
  type: "selector";
  selector: string;
  label: string;
};

/** Coordinate point from Beacon tags */
export type PointCoords = {
  type: "coords";
  x: number;
  y: number;
  label: string;
};

export type Point = PointSelector | PointCoords;

export type Draw = {
  type?: "rect" | "node" | "arrow";
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  color: string;
  label: string;
};

const POINT_BLOCK = /\[POINT:((?:[^\]"]*|"[^"]*")*)\]/g;
const DRAW_BLOCK  = /\[DRAW:((?:[^\]"]*|"[^"]*")*)\]/g;

const NETRA_TOOLS = [
  {
    name: "exa_answer",
    description: `Get instant cited answers from the web.
Use for:
- Fact checking WhatsApp forwards or claims
- "Is this true/real/fake?"
- Current events, prices, news
- Any factual question needing web data
- Verifying information the user is reading
Returns synthesized answer with sources.`,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: `The question to answer.
Be specific. Include context from the screenshot.
For fact checking add "fact check" or "is this true".
Example: "India government free LPG cylinders 2026 fact check"`,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "exa_search",
    description: `Search the web semantically.
Use for:
- Finding specific websites or pages
- "Where can I find X?"
- Looking up products, services, companies
- Finding documentation or tutorials
- Any "find me" type query
Returns list of relevant pages with descriptions.`,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query",
        },
        numResults: {
          type: "number",
          description: "Number of results (default 5, max 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "exa_contents",
    description: `Extract and read the full content of a webpage.
Use for:
- "Explain this page to me"
- "Summarize this article"
- "What does this terms of service say?"
- "What are the key points on this page?"
- Reading pages that are too long for screenshot
- Understanding complex documents
Requires the URL of the page to read.`,
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full URL of the page to read. Extract from the screenshot or conversation context.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "exa_similar",
    description: `Find pages similar to a given URL.
Use for:
- "Are there similar jobs?"
- "Find me alternatives to this product"
- "What other sites are like this?"
- "Show me similar articles"
- Competitive research
Requires the URL of the reference page.`,
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL of the page to find similar pages for",
        },
        numResults: {
          type: "number",
          description: "Number of similar pages to find (default 5)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "exa_research",
    description: `Do deep comprehensive research on a topic.
Use for:
- "Research this company before I apply"
- "Tell me everything about X"
- "Do a deep dive on this topic"
- "Find all information about this person/company"
- Any request that needs comprehensive coverage
Returns structured research from 10 sources.`,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: `Comprehensive research query.
Be specific about what aspects to research.
Example: "Anthropic AI company culture, products, funding history, and recent news"`,
        },
      },
      required: ["query"],
    },
  },
] as const;

function readAttr(block: string, name: string): string | undefined {
  const re = new RegExp(`${name}=("([^"]*)"|([^\\s\\]]+))`, "i");
  const m = block.match(re);
  if (!m) return undefined;
  return m[2] !== undefined ? m[2] : m[3];
}

function readNumber(block: string, name: string): number | undefined {
  const raw = readAttr(block, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function parsePoints(raw: string): Point[] {
  const out: Point[] = [];
  for (const match of raw.matchAll(POINT_BLOCK)) {
    const inner = match[1] ?? "";
    const selector = readAttr(inner, "selector");
    const label = readAttr(inner, "label") ?? "";
    if (selector !== undefined) {
      out.push({ type: "selector", selector, label });
      continue;
    }
    const x = readNumber(inner, "x");
    const y = readNumber(inner, "y");
    if (x !== undefined && y !== undefined) {
      out.push({ type: "coords", x, y, label });
    }
  }
  return out;
}

export function parseDraws(raw: string): Draw[] {
  const out: Draw[] = [];
  for (const match of raw.matchAll(DRAW_BLOCK)) {
    const inner = match[1] ?? "";
    const type = readAttr(inner, "type") ?? "";
    const color = readAttr(inner, "color") ?? "#20b8cd";
    const label = readAttr(inner, "label") ?? "";

    if (type === "node") {
      const x = readNumber(inner, "x");
      const y = readNumber(inner, "y");
      if (x !== undefined && y !== undefined) {
        out.push({ type: "node", x, y, color, label });
      }
      continue;
    }

    if (type === "arrow") {
      const fromX = readNumber(inner, "fromX");
      const fromY = readNumber(inner, "fromY");
      const toX = readNumber(inner, "toX");
      const toY = readNumber(inner, "toY");
      if (
        fromX !== undefined &&
        fromY !== undefined &&
        toX !== undefined &&
        toY !== undefined
      ) {
        out.push({ type: "arrow", fromX, fromY, toX, toY, color, label });
      }
      continue;
    }

    const x1 = readNumber(inner, "x1");
    const y1 = readNumber(inner, "y1");
    const x2 = readNumber(inner, "x2");
    const y2 = readNumber(inner, "y2");
    if (
      x1 !== undefined &&
      y1 !== undefined &&
      x2 !== undefined &&
      y2 !== undefined
    ) {
      out.push({ type: "rect", x1, y1, x2, y2, color, label });
    }
  }
  return out;
}

export function cleanText(raw: string): string {
  return raw
    .replace(POINT_BLOCK, "")
    .replace(DRAW_BLOCK, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeHistory(
  conversationHistory: unknown
): Array<{ role: "user" | "assistant"; content: unknown }> {
  if (!Array.isArray(conversationHistory)) return [];
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const item of conversationHistory) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    messages.push({ role, content });
  }
  return messages;
}

/** Natural register (esp. Hindi): avoid stiff "textbook" tone in model output. */
function localeStyleHint(language: string): string {
  const tag = language.toLowerCase().trim();
  if (tag.startsWith("hi")) {
    return `Language and tone (Hindi): Write the way people actually speak—warm, natural बोलचाल की हिंदी, like a friend on a call. Avoid stiff textbook Hindi, "news reader" phrasing, or long sentences heavy with formal/Sanskrit words unless the user clearly uses that style. It is good and natural to keep common English words for UI in speech (Hinglish)—e.g. button, sign in, link—when that is how a real person would say it. Keep Devanagari lines short, clear, and human. [POINT] label text can be short everyday Hindi.`;
  }
  if (tag.startsWith("zh")) {
    return `Language and tone: Be conversational in Chinese—natural, not like a literal translation.`;
  }
  return `Language and tone: Sound like a real person helping a friend—warm and easy, not a translated manual.`;
}

type ScreenMeta = {
  imageWidth: number;
  imageHeight: number;
  cssWidth: number;
  cssHeight: number;
};

type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
};

type AnthropicContentBlock =
  | { type: "text"; text?: string }
  | ToolUseBlock
  | Record<string, unknown>;

function userAskText(
  transcript: string,
  language: string,
  screenMeta: ScreenMeta | undefined,
  currentUrl: string | null
): string {
  const tag = language.toLowerCase().trim();
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
  return `User says: "${transcript}"${extra}
Current page: ${currentUrl || "URL not available."}${spatial}

Respond in ${language}.`;
}

async function runNetraTool(
  block: ToolUseBlock,
  env: Env,
  currentUrl: string | null
): Promise<string> {
  if (!env.EXA_API_KEY) {
    return "Tool error: EXA_API_KEY is not configured.";
  }
  const input = block.input || {};
  const query = typeof input.query === "string" ? input.query : "";
  const inputUrl = typeof input.url === "string" ? input.url : "";
  const url = inputUrl.startsWith("http") ? inputUrl : currentUrl;
  const numResults =
    typeof input.numResults === "number" && Number.isFinite(input.numResults)
      ? input.numResults
      : 3;

  try {
    switch (block.name) {
      case "exa_answer":
        return await exaAnswer(query, env.EXA_API_KEY);
      case "exa_search":
        return await exaSearch(query, env.EXA_API_KEY, numResults);
      case "exa_contents":
        return url
          ? await exaContents(url, env.EXA_API_KEY)
          : "Tool error: URL not available for page content extraction.";
      case "exa_similar":
        return url
          ? await exaSimilar(url, env.EXA_API_KEY, numResults)
          : "Tool error: URL not available for similar page search.";
      case "exa_research":
        return await exaResearch(query, env.EXA_API_KEY);
      default:
        return `Tool error: Unknown tool ${block.name}.`;
    }
  } catch (e) {
    return `Tool error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return errorJson("Method not allowed", 405);
  }

  let body: {
    screenshot?: string;
    transcript?: string;
    language?: string;
    conversationHistory?: unknown;
    screenshotMediaType?: string;
    screenMeta?: ScreenMeta;
    currentUrl?: string | null;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorJson("Invalid JSON body", 400);
  }

  const screenshot = body.screenshot;
  const transcript = body.transcript;
  const language =
    typeof body.language === "string" && body.language.length > 0
      ? body.language
      : "English";

  if (typeof screenshot !== "string" || screenshot.length === 0) {
    return errorJson("Missing or invalid screenshot", 400);
  }
  if (typeof transcript !== "string") {
    return errorJson("Missing or invalid transcript", 400);
  }

  const mediaTypeRaw = body.screenshotMediaType;
  const media_type =
    mediaTypeRaw === "image/png" || mediaTypeRaw === "image/webp"
      ? mediaTypeRaw
      : "image/jpeg";
  const currentUrl =
    typeof body.currentUrl === "string" && body.currentUrl.startsWith("http")
      ? body.currentUrl
      : null;
  const pageLine = currentUrl
    ? `CURRENT PAGE URL: ${currentUrl}`
    : "CURRENT PAGE URL: URL not available.";

  const systemPrompt = `You are Netra (नेत्र), an AI eye living in the user's browser.
You see their screen and guide them spatially. You also have access to the entire web through your search tools.
Remember the conversation context and refer back to previous steps when relevant.
When you've guided them to click something, anticipate their next need.

${pageLine}
RESPOND IN: ${language}

${localeStyleHint(language)}

SPATIAL GUIDANCE:
[POINT:selector="CSS_SELECTOR" label="description"]
[POINT:x=N y=N label="description"]
[DRAW:type="rect" x1=N y1=N x2=N y2=N color="#20b8cd" label="description"]
[DRAW:type="node" x=N y=N label="diagram node"]
[DRAW:type="arrow" fromX=N fromY=N toX=N toY=N label="relationship"]

DIAGRAM RULE:
When the user asks to draw, diagram, visualize, explain a tree/flow/structure, or says "show me visually", create a compact overlay diagram with 3–8 DRAW tags. Use node tags for concepts and arrow tags for relationships. Put the diagram in open/low-importance screen space when possible.

TOOL USE — STRICT RULES:

NEVER use tools for:
- Navigation questions ("where is X button", "how do I click X", "find the search bar")
- Questions answerable from the screenshot alone
- UI guidance of any kind

ONLY use tools when the user explicitly asks for:
- Fact checking: user says "is this true", "fact check", "verify this", "is this real"
- Current information: "what is the latest", "current price", "today's news"
- Page explanation: "explain this page", "summarize this article", "what does this say"
- Finding alternatives: "find similar", "are there alternatives", "what else is like this"
- Research: "research this", "tell me about this company"

When in doubt — DO NOT use tools. Answer from screenshot only.
Tools add 2–3 seconds of latency. Only use them when clearly necessary.
When you use a search tool, keep your spoken response to 1 sentence maximum — the user can see details in the bubble.

Rules:
- ALWAYS output at least one [POINT] tag — required in every single response
- Keep responses under 2 sentences — you are a guide not a lecturer
- Prefer a **unique, specific** CSS selector (id, data-testid, aria-label) when only one clear target exists; avoid generic selectors that match many elements. If no unique selector, use [POINT:x= y=] in **screenshot image pixel** coordinates.
- [POINT] / [DRAW] x,y values use the screenshot image pixel space (stated in the user message), not relative or normalized units
- For fact checks: start with ✓ TRUE / ✗ FALSE / ⚠ MISLEADING
- Respond in ${language}`;

  const history = normalizeHistory(body.conversationHistory);
  const screenMeta =
    body.screenMeta &&
    typeof body.screenMeta === "object" &&
    typeof (body.screenMeta as ScreenMeta).imageWidth === "number" &&
    typeof (body.screenMeta as ScreenMeta).imageHeight === "number"
      ? (body.screenMeta as ScreenMeta)
      : undefined;

  let currentMessages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    ...history,
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type,
            data: screenshot,
          },
        },
        {
          type: "text",
          text: userAskText(transcript, language, screenMeta, currentUrl),
        },
      ],
    },
  ];

  let rawText = "I was unable to process that request.";
  let iteration = 0;
  while (iteration < 5) {
    iteration++;
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: systemPrompt,
        tools: NETRA_TOOLS,
        tool_choice: { type: "auto" },
        messages: currentMessages,
      }),
    });

    let data: unknown;
    try {
      data = await anthropicRes.json();
    } catch {
      return errorJson("Anthropic returned invalid JSON", 502);
    }

    if (!anthropicRes.ok) {
      const err = data as { error?: { message?: string } };
      const msg = err?.error?.message ?? `Anthropic error (${anthropicRes.status})`;
      return errorJson(msg, anthropicRes.status >= 400 && anthropicRes.status < 600 ? anthropicRes.status : 502);
    }

    const responseData = data as {
      content?: AnthropicContentBlock[];
      stop_reason?: string;
    };
    const content = Array.isArray(responseData.content) ? responseData.content : [];

    if (responseData.stop_reason === "tool_use") {
      const toolUseBlocks = content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => ({
          type: "tool_result",
          tool_use_id: block.id,
          content: await runNetraTool(block, env, currentUrl),
        }))
      );

      currentMessages = [
        ...currentMessages,
        { role: "assistant", content },
        { role: "user", content: toolResults },
      ];
      continue;
    }

    const textBlock = content.find(
      (b): b is { type: "text"; text?: string } => b.type === "text"
    );
    rawText = textBlock?.text || rawText;
    break;
  }

  const points = parsePoints(rawText);
  const draws = parseDraws(rawText);
  const text = cleanText(rawText);

  return json({ text, points, draws });
}

async function handleTTS(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return errorJson("Method not allowed", 405);
  }

  let body: { text?: string; voiceId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorJson("Invalid JSON body", 400);
  }

  const { text, voiceId } = body;
  if (typeof text !== "string" || text.length === 0) {
    return errorJson("Missing or invalid text", 400);
  }
  if (typeof voiceId !== "string" || voiceId.length === 0) {
    return errorJson("Missing or invalid voiceId", 400);
  }

  const elevenRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!elevenRes.ok) {
    let detail = "";
    try {
      detail = await elevenRes.text();
    } catch {
      /* ignore */
    }
    return errorJson("ElevenLabs TTS failed", elevenRes.status, {
      detail: detail.slice(0, 500),
    });
  }

  const headers = new Headers();
  headers.set("Content-Type", "audio/mpeg");
  for (const [k, v] of Object.entries(corsHeaders)) {
    headers.set(k, v);
  }

  return new Response(elevenRes.body, { status: 200, headers });
}

async function handleTranscribeToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return errorJson("Method not allowed", 405);
  }

  const key = env.ASSEMBLYAI_API_KEY;
  if (!key || key.length === 0) {
    return errorJson(
      "AssemblyAI is not configured on this worker (missing ASSEMBLYAI_API_KEY)",
      503
    );
  }

  const url = new URL("https://streaming.assemblyai.com/v3/token");
  url.searchParams.set("expires_in_seconds", "600");

  const tokenRes = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: key },
  });

  let data: unknown;
  try {
    data = await tokenRes.json();
  } catch {
    return errorJson("AssemblyAI returned invalid JSON", 502);
  }

  if (!tokenRes.ok) {
    const err = data as { error?: string };
    return errorJson(err?.error ?? "Failed to create AssemblyAI token", tokenRes.status);
  }

  const token = (data as { token?: string }).token;
  if (typeof token !== "string" || !token) {
    return errorJson("AssemblyAI response missing token", 502);
  }

  return json({ token });
}

function handleHealth(request: Request): Response {
  if (request.method !== "GET") {
    return errorJson("Method not allowed", 405);
  }
  return json({ status: "ok", timestamp: new Date().toISOString() });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    try {
      if (path === "/chat") {
        return await handleChat(request, env);
      }
      if (path === "/tts") {
        return await handleTTS(request, env);
      }
      if (path === "/transcribe-token") {
        return await handleTranscribeToken(request, env);
      }
      if (path === "/health") {
        return handleHealth(request);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Internal error";
      console.error("beacon-proxy error:", e);
      return errorJson(message, 500);
    }

    return new Response("Not found", withCors({ status: 404 }));
  },
};
