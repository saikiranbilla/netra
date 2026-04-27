// =============================================================================
// Netra / Beacon — Content script: full-screen SVG overlay + sparkle + drawings
// =============================================================================
// Injected on <all_urls>. pointer-events: none on overlay so the page stays usable.
// =============================================================================

const BEACON_NS = "http://www.w3.org/2000/svg";
const NETRA_BG = "#111111";
const NETRA_SURFACE = "#1a1a1a";
const NETRA_SURFACE_2 = "#242424";
const NETRA_BORDER = "rgba(255,255,255,0.08)";
const NETRA_ACCENT = "#20b8cd";
const NETRA_ACCENT_GLOW = "rgba(32, 184, 205, 0.25)";
const NETRA_TEXT = "#ffffff";
const NETRA_TEXT_MUTED = "rgba(255,255,255,0.45)";
const INDIGO = NETRA_ACCENT;
const SPARKLE_SCALE = 0.72;
const SPARKLE_HALF = 12 * SPARKLE_SCALE;

/** @type {SVGSVGElement | null} */
let overlaySvg = null;
/** @type {SVGGElement | null} */
let drawingsLayer = null;
/** @type {SVGGElement | null} */
let sparkleGroup = null;
/** @type {SVGPathElement | null} */
let sparklePath = null;
let sparkleX = window.innerWidth / 2;
let sparkleY = window.innerHeight / 2;
let sparkleVisible = false;
let sparkleRafId = null;
let currentHighlightedElement = null;

/** Auto-follow: track highlighted element for click-to-continue */
let netraAutoFollowEl = null;
let netraAutoFollowLabel = "";
let netraAutoFollowTimer = null;
let netraAutoFollowClickHandler = null;

/** @type {HTMLDivElement | null} */
let guidanceCaption = null;

const pendingTimeouts = new Set();
let sequenceToken = 0;
let overlayResizeBound = false;
let visualSessionId = 0;
let activeVisualSession = null;
let visualFinishTimer = null;
let lastSpokenReplyKey = "";
/** @type {import('roughjs').RoughSVG | null} */
let rc = null;

/**
 * Screenshot bitmap size vs CSS viewport. Model [POINT] / [DRAW] coords are in
 * **screenshot image pixels**; `captureVisibleTab` JPEG size often ≠ innerWidth/Height.
 * @type {{ imgW: number, imgH: number, cssW: number, cssH: number } | null}
 */
let captureScale = null;

/**
 * @param {string} dataUrl
 * @returns {Promise<{ w: number, h: number }>}
 */
function measureScreenshotDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("screenshot decode"));
    img.src = dataUrl;
  });
}

/**
 * When a selector matches many nodes, pick the one most visible in the viewport
 * (largest on-screen area, then biased toward center).
 * @param {NodeListOf<Element> | Element[]} nodes
 * @returns {Element | null}
 */
function pickBestVisibleElement(nodes) {
  if (!nodes || nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const vcx = vw / 2;
  const vcy = vh / 2;
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const area = ix * iy;
    if (area < 9) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dist = Math.hypot(cx - vcx, cy - vcy);
    const score = area - dist * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best || nodes[0];
}

/**
 * Map model coordinates (screenshot pixel space) to CSS client coordinates.
 * @param {number} x
 * @param {number} y
 * @returns {{ x: number, y: number }}
 */
function modelXYToClient(x, y) {
  if (!captureScale || !captureScale.imgW || !captureScale.imgH) {
    return { x, y };
  }
  const c = captureScale;
  return {
    x: (x / c.imgW) * c.cssW,
    y: (y / c.imgH) * c.cssH
  };
}

/**
 * @param {object} d draw or rect with x1,y1,x2,y2
 * @returns {object}
 */
function applyCaptureScaleToDraw(d) {
  if (!captureScale || !captureScale.imgW) return d;
  const c = captureScale;
  const sx = (v) => (v / c.imgW) * c.cssW;
  const sy = (v) => (v / c.imgH) * c.cssH;
  return {
    ...d,
    x1: sx(d.x1),
    y1: sy(d.y1),
    x2: sx(d.x2),
    y2: sy(d.y2)
  };
}

// -----------------------------------------------------------------------------
// Init: inject styles + SVG once
// -----------------------------------------------------------------------------
function injectBeaconStyles() {
  if (document.getElementById("beacon-overlay-styles")) return;
  const style = document.createElement("style");
  style.id = "beacon-overlay-styles";
  style.textContent = `
    #beacon-overlay {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      pointer-events: none;
      z-index: 999999;
      overflow: visible;
    }
    #beacon-drawings-layer {
      pointer-events: none;
    }
    #netra-sparkle {
      opacity: 0.92;
      transform-origin: center;
      filter: drop-shadow(0 0 3px rgba(32,184,205,0.65));
      transition: none;
      will-change: transform, filter, opacity;
    }
    #netra-sparkle-path {
      transform-box: fill-box;
      transform-origin: center;
      animation: netra-sparkle-rest 2.8s ease-in-out infinite;
      will-change: transform, filter;
    }
    @keyframes netra-sparkle-rest {
      0%, 100% { transform: rotate(0deg) scale(1); }
      50% { transform: rotate(0deg) scale(1.04); }
    }
    @keyframes netra-sparkle-land {
      0%   { transform: rotate(-25deg) scale(1.65); opacity: 0.35; }
      60%  { transform: rotate(8deg) scale(0.92); opacity: 1; }
      80%  { transform: rotate(-4deg) scale(1.06); }
      100% { transform: rotate(0deg) scale(1); opacity: 1; }
    }
    @keyframes netra-sparkle-speak {
      0%, 100% {
        transform: rotate(0deg) scale(1);
        filter: drop-shadow(0 0 3px rgba(32,184,205,0.7));
      }
      50% {
        transform: rotate(0deg) scale(1.12);
        filter: drop-shadow(0 0 8px rgba(32,184,205,0.95));
      }
    }
    .beacon-guidance-caption {
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%);
      max-width: min(90vw, 420px);
      padding: 10px 14px;
      border-radius: 999px;
      background: rgba(17, 17, 17, 0.9);
      color: rgba(255,255,255,0.72);
      font: 500 12px/1.35 'Inter', system-ui, sans-serif;
      letter-spacing: -0.01em;
      -webkit-font-smoothing: antialiased;
      border: 1px solid ${NETRA_BORDER};
      backdrop-filter: blur(16px);
      box-shadow: 0 8px 30px rgba(0,0,0,0.35);
      pointer-events: none;
      z-index: 999995;
      opacity: 0;
      transition: opacity 200ms ease;
    }
    .beacon-guidance-caption.is-visible {
      opacity: 1;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function createSvgEl(name) {
  return document.createElementNS(BEACON_NS, name);
}

function ensureOverlay() {
  if (overlaySvg?.isConnected) return;
  overlaySvg = null;
  drawingsLayer = null;
  sparkleGroup = null;
  sparklePath = null;

  injectBeaconStyles();

  const svg = createSvgEl("svg");
  svg.id = "beacon-overlay";
  svg.setAttribute("aria-hidden", "true");

  const defs = createSvgEl("defs");
  const marker = createSvgEl("marker");
  marker.setAttribute("id", "beacon-arrowhead");
  marker.setAttribute("markerWidth", "10");
  marker.setAttribute("markerHeight", "10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "3");
  marker.setAttribute("orient", "auto");
  const arrowPath = createSvgEl("path");
  arrowPath.setAttribute("d", "M0,0 L0,6 L9,3 z");
  arrowPath.setAttribute("fill", NETRA_ACCENT);
  marker.appendChild(arrowPath);
  defs.appendChild(marker);

  const dLayer = createSvgEl("g");
  dLayer.id = "beacon-drawings-layer";

  const sGroup = createSvgEl("g");
  sGroup.id = "netra-sparkle";

  const sPath = createSvgEl("path");
  sPath.id = "netra-sparkle-path";
  sPath.setAttribute(
    "d",
    "M12 2 C12.9 8 16 11.1 22 12 C16 12.9 12.9 16 12 22 C11.1 16 8 12.9 2 12 C8 11.1 11.1 8 12 2 Z"
  );
  sPath.setAttribute("fill", "rgba(32,184,205,0.08)");
  sPath.setAttribute("stroke", NETRA_ACCENT);
  sPath.setAttribute("stroke-width", "1.35");
  sPath.setAttribute("stroke-linejoin", "round");
  sGroup.appendChild(sPath);

  svg.appendChild(defs);
  svg.appendChild(dLayer);
  svg.appendChild(sGroup);

  document.body.appendChild(svg);

  // Initialize Rough.js SVG renderer (rough.js loaded as content script before us)
  if (typeof rough !== "undefined") {
    rc = rough.svg(svg);
  }

  overlaySvg = svg;
  drawingsLayer = dLayer;
  sparkleGroup = sGroup;
  sparklePath = sPath;

  syncOverlaySize();
  sparkleX = window.innerWidth / 2;
  sparkleY = window.innerHeight / 2;
  sparkleVisible = true;
  positionSparkle(sparkleX, sparkleY);
  if (!overlayResizeBound) {
    window.addEventListener("resize", syncOverlaySize, { passive: true });
    overlayResizeBound = true;
  }
}

function syncOverlaySize() {
  if (!overlaySvg) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  overlaySvg.setAttribute("width", String(w));
  overlaySvg.setAttribute("height", String(h));
  overlaySvg.style.width = `${w}px`;
  overlaySvg.style.height = `${h}px`;
}

function trackTimeout(cb, ms) {
  const id = window.setTimeout(() => {
    pendingTimeouts.delete(id);
    cb();
  }, ms);
  pendingTimeouts.add(id);
  return id;
}

function clearAllTimeouts() {
  for (const id of pendingTimeouts) window.clearTimeout(id);
  pendingTimeouts.clear();
}

function clearElementLabel() {
  const label = document.getElementById("netra-element-label");
  if (!label) return;
  label.style.opacity = "0";
  label.style.transform = "translateY(-4px)";
  window.setTimeout(() => label.remove(), 200);
}

function onDocumentClickForHighlight(e) {
  if (
    netraAutoFollowEl &&
    currentHighlightedElement &&
    (e.target === currentHighlightedElement ||
      currentHighlightedElement.contains(e.target))
  ) {
    return;
  }
  clearHighlight();
}

function clearHighlight() {
  cancelAutoFollow();
  if (!currentHighlightedElement) {
    clearElementLabel();
    return;
  }
  const el = currentHighlightedElement;
  const originalTransition = el._netraOriginalTransition || "";
  el.style.transition =
    "outline 300ms ease, box-shadow 300ms ease, outline-offset 300ms ease";
  el.style.outline = el._netraOriginalOutline || "";
  el.style.outlineOffset = el._netraOriginalOutlineOffset || "";
  el.style.boxShadow = el._netraOriginalBoxShadow || "";
  el.style.position = el._netraOriginalPosition || "";
  el.style.zIndex = el._netraOriginalZIndex || "";

  delete el._netraOriginalOutline;
  delete el._netraOriginalOutlineOffset;
  delete el._netraOriginalTransition;
  delete el._netraOriginalBoxShadow;
  delete el._netraOriginalPosition;
  delete el._netraOriginalZIndex;

  currentHighlightedElement = null;
  clearElementLabel();
  window.setTimeout(() => {
    if (currentHighlightedElement !== el) {
      el.style.transition = originalTransition;
    }
  }, 320);
}

function isInteractiveElement(element) {
  if (!element) return false;
  return (
    element.tagName === "BUTTON" ||
    element.tagName === "A" ||
    element.tagName === "INPUT" ||
    element.tagName === "SELECT" ||
    element.tagName === "TEXTAREA" ||
    element.getAttribute("role") === "button" ||
    element.getAttribute("role") === "link" ||
    element.onclick !== null ||
    element.getAttribute("tabindex") !== null
  );
}

/**
 * Collect visible interactive elements in the viewport and return a compact
 * descriptor array for Claude so it can emit accurate [POINT:selector="..."] tags.
 */
function collectInteractiveElements(limit = 40) {
  const tags = "a,button,input,select,textarea,[role='button'],[role='link'],[tabindex]";
  const all = document.querySelectorAll(tags);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cx = vw / 2;
  const cy = vh / 2;
  const items = [];
  for (const el of all) {
    if (el.closest("#netra-companion,#beacon-overlay")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
    const text = (
      el.getAttribute("aria-label") ||
      el.textContent ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      ""
    ).trim().slice(0, 60);
    if (!text && el.tagName !== "INPUT" && el.tagName !== "SELECT") continue;
    const selector = buildUniqueSelector(el);
    items.push({
      tag: el.tagName.toLowerCase(),
      text,
      selector,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      dist: Math.hypot(rect.left + rect.width / 2 - cx, rect.top + rect.height / 2 - cy)
    });
  }
  items.sort((a, b) => a.dist - b.dist);
  return items.slice(0, limit).map(({ dist, ...rest }) => rest);
}

function buildUniqueSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  const aria = el.getAttribute("aria-label");
  if (aria) {
    const sel = `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }
  const name = el.getAttribute("name");
  if (name) {
    const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (parent) {
    const siblings = parent.querySelectorAll(`:scope > ${tag}`);
    if (siblings.length === 1 && parent.id) {
      return `#${CSS.escape(parent.id)} > ${tag}`;
    }
    const idx = Array.from(siblings).indexOf(el);
    if (parent.id) {
      return `#${CSS.escape(parent.id)} > ${tag}:nth-child(${idx + 1})`;
    }
  }
  return "";
}

function isReasonableElementTarget(element, source) {
  if (!element || typeof element.getBoundingClientRect !== "function") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const viewportArea = window.innerWidth * window.innerHeight;
  const area = rect.width * rect.height;
  if (source === "coordinate") {
    // Coordinates are the most precise signal. Avoid expanding a slightly
    // misplaced pixel hit into a giant parent/logo/search-area annotation.
    return rect.width <= 180 && rect.height <= 80 && area <= viewportArea * 0.08;
  }
  return rect.width <= window.innerWidth * 0.9 && rect.height <= window.innerHeight * 0.35;
}

function getElementAtPoint(x, y) {
  const raw = document.elementFromPoint(x, y);
  if (!raw) return null;
  let node = raw;
  while (node && node !== document.body && node !== document.documentElement) {
    if (isInteractiveElement(node)) return node;
    node = node.parentElement;
  }
  return raw;
}

/**
 * Probe a small grid around (cx, cy) and return the nearest interactive element.
 * Falls back to the direct hit if no interactive element is found nearby.
 */
function findNearestInteractiveElement(cx, cy) {
  const direct = getElementAtPoint(cx, cy);
  if (direct && isInteractiveElement(direct)) return direct;

  const offsets = [10, -10, 20, -20];
  let best = null;
  let bestDist = Infinity;
  for (const dx of offsets) {
    for (const dy of offsets) {
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) continue;
      const el = document.elementFromPoint(px, py);
      if (!el) continue;
      let node = el;
      while (node && node !== document.body && node !== document.documentElement) {
        if (isInteractiveElement(node)) {
          const d = Math.hypot(dx, dy);
          if (d < bestDist) {
            bestDist = d;
            best = node;
          }
          break;
        }
        node = node.parentElement;
      }
    }
  }
  return best || direct;
}

function highlightElement(element, label) {
  if (!element || !isInteractiveElement(element)) return;
  clearHighlight();
  currentHighlightedElement = element;

  element._netraOriginalOutline = element.style.outline;
  element._netraOriginalOutlineOffset = element.style.outlineOffset;
  element._netraOriginalTransition = element.style.transition;
  element._netraOriginalBoxShadow = element.style.boxShadow;
  element._netraOriginalPosition = element.style.position;
  element._netraOriginalZIndex = element.style.zIndex;

  element.style.transition =
    "outline 200ms ease, box-shadow 200ms ease, outline-offset 200ms ease";
  element.style.outline = "1px solid rgba(32, 184, 205, 0.9)";
  element.style.outlineOffset = "2px";
  element.style.boxShadow =
    "0 0 0 2px rgba(32, 184, 205, 0.07), 0 0 10px rgba(32, 184, 205, 0.12)";
  element.style.position =
    element.style.position === "static" || !element.style.position
      ? "relative"
      : element.style.position;
  element.style.zIndex = "999985";

  trackTimeout(() => {
    if (element !== currentHighlightedElement) return;
    element.style.outline = "1px solid rgba(32, 184, 205, 0.5)";
    element.style.outlineOffset = "2px";
    element.style.boxShadow =
      "0 0 0 1px rgba(32, 184, 205, 0.05), 0 0 8px rgba(32, 184, 205, 0.08)";
  }, 400);

  attachAutoFollow(element, label || "");
}

function attachAutoFollow(element, label) {
  cancelAutoFollow();
  netraAutoFollowEl = element;
  netraAutoFollowLabel = label ||
    (element.getAttribute("aria-label") ||
     element.textContent || "").trim().slice(0, 60) ||
    "that element";

  netraAutoFollowClickHandler = () => {
    const state = getNetraState();
    if (state === "SPEAKING" || state === "PROCESSING" || state === "LISTENING") return;
    const desc = netraAutoFollowLabel;
    cancelAutoFollow();
    clearHighlight();
    setStatusLabel("Continuing…", { persist: true });

    // Persist intent so a page navigation doesn't lose it — the new content
    // script picks it up on init if the timer never fires here.
    chrome.storage.session.set({
      netraAutoFollowPending: { label: desc, ts: Date.now() }
    }).catch(() => {});

    netraAutoFollowTimer = setTimeout(() => {
      netraAutoFollowTimer = null;
      chrome.storage.session.remove("netraAutoFollowPending").catch(() => {});
      const s = getNetraState();
      if (s === "SPEAKING" || s === "PROCESSING" || s === "LISTENING") return;
      void runNetraPipeline(`I clicked "${desc}". What should I do next?`);
    }, 800);
  };

  element.addEventListener("click", netraAutoFollowClickHandler, { once: true, capture: false });
}

function cancelAutoFollow() {
  if (netraAutoFollowTimer) {
    clearTimeout(netraAutoFollowTimer);
    netraAutoFollowTimer = null;
    chrome.storage.session.remove("netraAutoFollowPending").catch(() => {});
  }
  if (netraAutoFollowEl && netraAutoFollowClickHandler) {
    netraAutoFollowEl.removeEventListener("click", netraAutoFollowClickHandler, { capture: false });
  }
  netraAutoFollowEl = null;
  netraAutoFollowLabel = "";
  netraAutoFollowClickHandler = null;
}

function resumeAutoFollowAfterNavigation() {
  chrome.storage.session.get("netraAutoFollowPending").then((data) => {
    const pending = data?.netraAutoFollowPending;
    if (!pending || !pending.label) return;
    // Stale if older than 8 seconds (page load can take a moment)
    if (Date.now() - pending.ts > 8000) {
      chrome.storage.session.remove("netraAutoFollowPending").catch(() => {});
      return;
    }
    chrome.storage.session.remove("netraAutoFollowPending").catch(() => {});
    const desc = pending.label;
    setStatusLabel("Continuing…", { persist: true });
    // Wait for the page to render before capturing a screenshot
    setTimeout(() => {
      const s = getNetraState();
      if (s === "SPEAKING" || s === "PROCESSING" || s === "LISTENING") return;
      void runNetraPipeline(`I clicked "${desc}" and the page changed. What should I do next?`);
    }, 1200);
  }).catch(() => {});
}

function showElementLabel(element, labelText) {
  clearElementLabel();
  if (!element || !labelText) return;
  const rect =
    typeof element.getBoundingClientRect === "function"
      ? element.getBoundingClientRect()
      : element;
  const left = typeof rect.left === "number" ? rect.left : rect.x;
  const top = typeof rect.top === "number" ? rect.top : rect.y;
  const bottom = typeof rect.bottom === "number" ? rect.bottom : top;
  const label = document.createElement("div");
  label.id = "netra-element-label";
  label.textContent = labelText;
  label.style.cssText = `
    position: fixed;
    left: ${left}px;
    top: ${top - 32}px;
    background: rgba(17, 17, 17, 0.95);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(32, 184, 205, 0.2);
    border-radius: 6px;
    padding: 4px 10px;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 11px;
    font-weight: 500;
    color: ${NETRA_ACCENT};
    letter-spacing: 0.02em;
    white-space: nowrap;
    z-index: 999996;
    pointer-events: none;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 200ms ease, transform 200ms ease;
    -webkit-font-smoothing: antialiased;
  `;
  document.body.appendChild(label);

  if (top < 40) {
    label.style.top = `${bottom + 8}px`;
  }
  if (left + label.offsetWidth > window.innerWidth - 16) {
    label.style.left = `${window.innerWidth - label.offsetWidth - 16}px`;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      label.style.opacity = "1";
      label.style.transform = "translateY(0)";
    });
  });
}

function isInViewport(element) {
  if (!element) return true;
  const rect = element.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth
  );
}

// -----------------------------------------------------------------------------
// Geometry: resolve point → pixel center + optional element
// -----------------------------------------------------------------------------
function resolvePointTarget(point) {
  let type = point?.type;

  // Normalise worker's "coords" alias to "coordinate" so both
  // the direct-API path (claude.js) and worker path (index.ts) work.
  if (type === "coords") type = "coordinate";

  // Infer type from shape when missing/unknown
  if (!type || (type !== "selector" && type !== "coordinate")) {
    if (point?.selector) type = "selector";
    else if (typeof point?.x === "number" && typeof point?.y === "number") type = "coordinate";
  }

  if (type === "selector" && point.selector) {
    try {
      const matches = document.querySelectorAll(point.selector);
      const el = pickBestVisibleElement(matches);
      if (el) {
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          el,
          rect,
          source: "selector",
          label: point.label || ""
        };
      }
    } catch (_) {
      /* invalid selector — fall through */
    }
  }

  if (type === "coordinate") {
    const { x, y } = modelXYToClient(point.x, point.y);
    const el = findNearestInteractiveElement(x, y);
    const rect = el?.getBoundingClientRect?.() || null;
    return {
      x: rect ? rect.left + rect.width / 2 : x,
      y: rect ? rect.top + rect.height / 2 : y,
      el,
      rect,
      source: "coordinate",
      label: point.label || ""
    };
  }

  // Last resort: viewport centre (point was completely unresolvable)
  return {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    el: null,
    rect: null,
    source: "fallback",
    label: point?.label || ""
  };
}

function animateRoughPaths(group) {
  group.querySelectorAll("path").forEach((path) => {
    try {
      const length = path.getTotalLength();
      path.style.strokeDasharray = String(length);
      path.style.strokeDashoffset = String(length);
      path.style.transition = "stroke-dashoffset 500ms ease";
      requestAnimationFrame(() => {
        path.style.strokeDashoffset = "0";
      });
    } catch {
      /* Rough.js path length can fail in rare browser edge cases. */
    }
  });
}

function positionSparkle(x, y) {
  if (!sparkleGroup) return;
  sparkleGroup.setAttribute(
    "transform",
    `translate(${x - SPARKLE_HALF}, ${y - SPARKLE_HALF}) scale(${SPARKLE_SCALE})`
  );
}

function setSparkleSpeaking(isSpeaking) {
  if (!sparklePath) return;
  sparklePath.style.animation = isSpeaking
    ? "netra-sparkle-speak 0.6s ease-in-out infinite"
    : "netra-sparkle-rest 2.8s ease-in-out infinite";
}

function onSparkleLand(x, y) {
  if (!overlaySvg || !sparklePath || !sparkleGroup) return;
  positionSparkle(x, y);
  sparkleGroup.style.filter = "drop-shadow(0 0 3px rgba(32,184,205,0.65))";
  sparklePath.style.animation =
    "netra-sparkle-land 350ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards";

  const ripple = createSvgEl("circle");
  ripple.setAttribute("cx", String(x));
  ripple.setAttribute("cy", String(y));
  ripple.setAttribute("r", "3");
  ripple.setAttribute("fill", "none");
  ripple.setAttribute("stroke", NETRA_ACCENT);
  ripple.setAttribute("stroke-width", "1");
  ripple.setAttribute("opacity", "0.75");
  overlaySvg.appendChild(ripple);

  let rippleR = 3;
  let rippleOpacity = 0.75;
  const rippleInterval = window.setInterval(() => {
    rippleR += 1.4;
    rippleOpacity -= 0.07;
    ripple.setAttribute("r", String(rippleR));
    ripple.setAttribute("opacity", String(Math.max(0, rippleOpacity)));
    if (rippleOpacity <= 0) {
      window.clearInterval(rippleInterval);
      ripple.remove();
    }
  }, 16);

  trackTimeout(() => {
    if (netraState === "SPEAKING") {
      setSparkleSpeaking(true);
    } else {
      setSparkleSpeaking(false);
    }
  }, 350);
}

function startSparkleFlight(fromX, fromY, toX, toY) {
  ensureOverlay();
  if (!sparkleGroup || !sparklePath) return Promise.resolve();
  if (sparkleRafId !== null) {
    cancelAnimationFrame(sparkleRafId);
    sparkleRafId = null;
  }

  sparkleGroup.style.opacity = "1";
  sparkleGroup.style.filter = "drop-shadow(0 0 2px rgba(32,184,205,0.45))";
  sparklePath.style.animation = "none";
  sparkleVisible = true;

  const duration = 700;
  const start = performance.now();
  const cpX = (fromX + toX) / 2;
  const cpY = Math.min(fromY, toY) - 60;

  return new Promise((resolve) => {
    function animateFlight(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease =
        t < 0.5
          ? 4 * t * t * t
          : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const inv = 1 - ease;
      const x = inv * inv * fromX + 2 * inv * ease * cpX + ease * ease * toX;
      const y = inv * inv * fromY + 2 * inv * ease * cpY + ease * ease * toY;

      positionSparkle(x, y);
      sparkleX = x;
      sparkleY = y;

      if (t < 1) {
        sparkleRafId = requestAnimationFrame(animateFlight);
      } else {
        sparkleRafId = null;
        sparkleX = toX;
        sparkleY = toY;
        onSparkleLand(toX, toY);
        resolve();
      }
    }

    sparkleRafId = requestAnimationFrame(animateFlight);
  });
}

// -----------------------------------------------------------------------------
// Sparkle flight
// -----------------------------------------------------------------------------
async function flyToElement(point, opts = {}) {
  const { token, onFirstArrival } = opts;
  ensureOverlay();

  let target = resolvePointTarget(point);
  if (target.el && !isInViewport(target.el)) {
    target.el.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(400);
    if (token !== sequenceToken) return;
    target = resolvePointTarget(point);
  }

  if (!sparkleVisible) {
    sparkleVisible = true;
    sparkleX = window.innerWidth / 2;
    sparkleY = window.innerHeight / 2;
    positionSparkle(sparkleX, sparkleY);
  }

  if (token !== sequenceToken) return;

  await startSparkleFlight(sparkleX, sparkleY, target.x, target.y);
  await delay(50);
  if (token !== sequenceToken) return;

  if (typeof onFirstArrival === "function") {
    onFirstArrival();
  }

  const canUseElement =
    target.el && isReasonableElementTarget(target.el, target.source);
  if (canUseElement && target.el) {
    if (isInteractiveElement(target.el)) {
      highlightElement(target.el, target.label);
    } else {
      clearHighlight();
    }
  } else {
    clearHighlight();
  }
  await delay(150);
  if (token !== sequenceToken) return;
  if (target.label) {
    showElementLabel(
      canUseElement && target.el
        ? target.el
        : { left: target.x, top: target.y, bottom: target.y },
      target.label
    );
  }
  await delay(150);
  if (token !== sequenceToken) return;
}

function delay(ms) {
  return new Promise((resolve) => {
    const id = window.setTimeout(() => {
      pendingTimeouts.delete(id);
      resolve();
    }, ms);
    pendingTimeouts.add(id);
  });
}

// -----------------------------------------------------------------------------
// Drawing engine
// -----------------------------------------------------------------------------
function drawAnnotation(draw) {
  ensureOverlay();
  const d = applyCaptureScaleToDraw(draw);
  const color = d.color || INDIGO;
  const x = Math.min(d.x1, d.x2);
  const y = Math.min(d.y1, d.y2);
  const w = Math.abs(d.x2 - d.x1);
  const h = Math.abs(d.y2 - d.y1);
  const label = d.label || "";

  const g = createSvgEl("g");
  g.setAttribute("opacity", "0");
  g.style.transition = "opacity 300ms ease";
  g.style.pointerEvents = "none";

  if (rc) {
    const roughRect = rc.rectangle(x, y, w, h, {
      roughness: 1.2,
      stroke: color,
      strokeWidth: 2,
      fill: "rgba(32, 184, 205, 0.06)",
      fillStyle: "hachure",
      fillWeight: 0.8,
      hachureAngle: -41,
      hachureGap: 10,
    });
    roughRect.style.pointerEvents = "none";
    g.appendChild(roughRect);
  } else {
    const rect = createSvgEl("rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", "8");
    rect.setAttribute("ry", "8");
    rect.setAttribute("fill", color);
    rect.setAttribute("fill-opacity", "0.06");
    rect.setAttribute("stroke", color);
    rect.setAttribute("stroke-width", "2");
    rect.setAttribute("stroke-dasharray", "8 4");
    g.appendChild(rect);
  }

  if (label) {
    const text = createSvgEl("text");
    text.setAttribute("x", String(x + w / 2));
    text.setAttribute("y", String(y - 8));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", NETRA_TEXT);
    text.setAttribute("font-family", "Inter, system-ui, sans-serif");
    text.setAttribute("font-size", "12");
    text.setAttribute("font-weight", "600");
    text.setAttribute("paint-order", "stroke");
    text.setAttribute("stroke", NETRA_BG);
    text.setAttribute("stroke-width", "3");
    text.textContent = label;
    g.appendChild(text);
  }

  drawingsLayer.appendChild(g);
  requestAnimationFrame(() => g.setAttribute("opacity", "1"));
}

function drawDiagramNode(draw) {
  ensureOverlay();
  const p = modelXYToClient(draw.x, draw.y);
  const color = draw.color || INDIGO;
  const label = String(draw.label || "").slice(0, 36);
  const g = createSvgEl("g");
  g.setAttribute("opacity", "0");
  g.style.transition = "opacity 260ms ease, transform 260ms ease";
  g.style.pointerEvents = "none";

  const text = createSvgEl("text");
  text.setAttribute("x", String(p.x));
  text.setAttribute("y", String(p.y + 4));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("fill", NETRA_TEXT);
  text.setAttribute("font-family", "Inter, system-ui, sans-serif");
  text.setAttribute("font-size", "12");
  text.setAttribute("font-weight", "650");
  text.textContent = label || "Node";

  const approxWidth = Math.max(58, Math.min(160, (label.length || 4) * 7 + 28));
  const rect = createSvgEl("rect");
  rect.setAttribute("x", String(p.x - approxWidth / 2));
  rect.setAttribute("y", String(p.y - 18));
  rect.setAttribute("width", String(approxWidth));
  rect.setAttribute("height", "36");
  rect.setAttribute("rx", "18");
  rect.setAttribute("ry", "18");
  rect.setAttribute("fill", "rgba(17,17,17,0.9)");
  rect.setAttribute("stroke", color);
  rect.setAttribute("stroke-width", "1.25");
  rect.setAttribute("filter", "drop-shadow(0 0 8px rgba(32,184,205,0.22))");

  g.appendChild(rect);
  g.appendChild(text);
  drawingsLayer.appendChild(g);
  requestAnimationFrame(() => g.setAttribute("opacity", "1"));
}

function appendArrowLabel(group, x, y, label) {
  if (!label) return;
  const text = createSvgEl("text");
  text.setAttribute("x", String(x));
  text.setAttribute("y", String(y - 8));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("fill", NETRA_TEXT_MUTED);
  text.setAttribute("font-family", "Inter, system-ui, sans-serif");
  text.setAttribute("font-size", "11");
  text.setAttribute("font-weight", "600");
  text.setAttribute("paint-order", "stroke");
  text.setAttribute("stroke", NETRA_BG);
  text.setAttribute("stroke-width", "3");
  text.textContent = label.slice(0, 24);
  group.appendChild(text);
}

/**
 * Hand-drawn arrow/line using Rough.js (falls back to animated SVG path).
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @param {string} [color]
 * @param {string} [label]
 */
function drawArrow(fromX, fromY, toX, toY, color = INDIGO, label = "") {
  ensureOverlay();
  const a = modelXYToClient(fromX, fromY);
  const b = modelXYToClient(toX, toY);
  const g = createSvgEl("g");
  g.setAttribute("opacity", "0");
  g.style.transition = "opacity 300ms ease";
  g.style.pointerEvents = "none";

  if (rc) {
    const roughLine = rc.line(a.x, a.y, b.x, b.y, {
      roughness: 1.8,
      stroke: color,
      strokeWidth: 2,
    });
    roughLine.style.pointerEvents = "none";
    g.appendChild(roughLine);

    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const size = 9;
    const arrowHead = createSvgEl("path");
    const x1 = b.x - Math.cos(angle - Math.PI / 6) * size;
    const y1 = b.y - Math.sin(angle - Math.PI / 6) * size;
    const x2 = b.x - Math.cos(angle + Math.PI / 6) * size;
    const y2 = b.y - Math.sin(angle + Math.PI / 6) * size;
    arrowHead.setAttribute("d", `M ${b.x} ${b.y} L ${x1} ${y1} M ${b.x} ${b.y} L ${x2} ${y2}`);
    arrowHead.setAttribute("fill", "none");
    arrowHead.setAttribute("stroke", color);
    arrowHead.setAttribute("stroke-width", "2");
    arrowHead.setAttribute("stroke-linecap", "round");
    g.appendChild(arrowHead);

    appendArrowLabel(g, (a.x + b.x) / 2, (a.y + b.y) / 2, label);
    drawingsLayer.appendChild(g);
    requestAnimationFrame(() => g.setAttribute("opacity", "1"));
  } else {
    const path = createSvgEl("path");
    path.setAttribute("d", `M ${a.x} ${a.y} L ${b.x} ${b.y}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "3");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("marker-end", "url(#beacon-arrowhead)");
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
    path.style.transition = "stroke-dashoffset 600ms ease-out";
    g.appendChild(path);
    appendArrowLabel(g, (a.x + b.x) / 2, (a.y + b.y) / 2, label);
    drawingsLayer.appendChild(g);
    requestAnimationFrame(() => {
      g.setAttribute("opacity", "1");
      path.style.strokeDashoffset = "0";
    });
  }

}

function clearDrawingLayer() {
  if (!drawingsLayer) return;
  while (drawingsLayer.firstChild) drawingsLayer.removeChild(drawingsLayer.firstChild);
}

function fadeDrawingLayer(sessionId) {
  if (!drawingsLayer) return;
  const children = Array.from(drawingsLayer.children);
  if (!children.length) return;
  for (const child of children) {
    child.style.transition = "opacity 450ms ease";
    child.setAttribute("opacity", "0");
  }
  window.setTimeout(() => {
    if (activeVisualSession && activeVisualSession.id !== sessionId) return;
    clearDrawingLayer();
  }, 480);
}

function beginVisualSession() {
  if (visualFinishTimer) {
    window.clearTimeout(visualFinishTimer);
    visualFinishTimer = null;
  }
  visualSessionId += 1;
  activeVisualSession = {
    id: visualSessionId,
    hasCleared: false,
    hasDrawings: false,
    drawKeys: new Set()
  };
  return activeVisualSession;
}

function getVisualSession() {
  return activeVisualSession || beginVisualSession();
}

function finishVisualSession(sessionId = activeVisualSession?.id, delayMs = 1800) {
  if (!sessionId) return;
  if (visualFinishTimer) {
    window.clearTimeout(visualFinishTimer);
    visualFinishTimer = null;
  }
  visualFinishTimer = window.setTimeout(() => {
    if (!activeVisualSession || activeVisualSession.id !== sessionId) return;
    fadeDrawingLayer(sessionId);
    showGuidanceText("");
    activeVisualSession = null;
    visualFinishTimer = null;
  }, delayMs);
}

function cancelVisualSession() {
  if (visualFinishTimer) {
    window.clearTimeout(visualFinishTimer);
    visualFinishTimer = null;
  }
  activeVisualSession = null;
  clearDrawingLayer();
}

function drawKey(draw) {
  if (!draw) return "";
  if (draw.type === "node") {
    return `node:${Math.round(draw.x || 0)}:${Math.round(draw.y || 0)}:${draw.label || ""}`;
  }
  if (draw.type === "arrow") {
    return `arrow:${Math.round(draw.fromX || 0)}:${Math.round(draw.fromY || 0)}:${Math.round(draw.toX || 0)}:${Math.round(draw.toY || 0)}:${draw.label || ""}`;
  }
  return `rect:${Math.round(draw.x1 || 0)}:${Math.round(draw.y1 || 0)}:${Math.round(draw.x2 || 0)}:${Math.round(draw.y2 || 0)}:${draw.label || ""}`;
}

function showGuidanceText(text) {
  if (!text) {
    if (guidanceCaption) {
      guidanceCaption.classList.remove("is-visible");
      trackTimeout(() => {
        if (guidanceCaption && !guidanceCaption.classList.contains("is-visible")) {
          guidanceCaption.remove();
          guidanceCaption = null;
        }
      }, 220);
    }
    return;
  }
  ensureOverlay();
  if (!guidanceCaption) {
    guidanceCaption = document.createElement("div");
    guidanceCaption.className = "beacon-guidance-caption";
    document.body.appendChild(guidanceCaption);
  }
  guidanceCaption.textContent = text;
  requestAnimationFrame(() => guidanceCaption.classList.add("is-visible"));
}

// -----------------------------------------------------------------------------
// Sequencing
// -----------------------------------------------------------------------------
async function runBeaconSequence({ text, points, draws }) {
  console.log("[Netra CS] runBeaconSequence — points:", points?.length ?? 0, "draws:", draws?.length ?? 0, "text:", (text || "").slice(0, 80));
  const token = ++sequenceToken;
  const session = getVisualSession();
  if (visualFinishTimer) {
    window.clearTimeout(visualFinishTimer);
    visualFinishTimer = null;
  }

  if (!session.hasCleared) {
    clearAllTimeouts();
    clearDrawingLayer();
    clearHighlight();
    session.hasCleared = true;
  }

  showGuidanceText(text || "");

  const pts = Array.isArray(points) ? points : [];
  const drs = Array.isArray(draws) ? draws : [];

  let firstArrivalFired = false;
  const fireFirstArrival = () => {
    if (firstArrivalFired) return;
    firstArrivalFired = true;
    for (const d of drs) {
      if (!d) continue;
      const key = drawKey(d);
      if (!key || session.drawKeys.has(key)) continue;
      session.drawKeys.add(key);
      const isNode =
        d.type === "node" &&
        typeof d.x === "number" &&
        typeof d.y === "number";
      const isArrow =
        d.type === "arrow" ||
        (typeof d.fromX === "number" &&
          typeof d.fromY === "number" &&
          typeof d.toX === "number" &&
          typeof d.toY === "number");
      if (isNode) {
        drawDiagramNode(d);
        session.hasDrawings = true;
      } else if (isArrow) {
        drawArrow(d.fromX, d.fromY, d.toX, d.toY, d.color, d.label);
        session.hasDrawings = true;
      } else if (
        typeof d.x1 === "number" &&
        typeof d.y1 === "number" &&
        typeof d.x2 === "number" &&
        typeof d.y2 === "number"
      ) {
        drawAnnotation(d);
        session.hasDrawings = true;
      }
    }
  };

  if (pts.length === 0) {
    fireFirstArrival();
    return;
  }

  for (let i = 0; i < pts.length; i++) {
    if (token !== sequenceToken) return;
    if (i > 0) await delay(500);
    if (token !== sequenceToken) return;

    await flyToElement(pts[i], {
      token,
      onFirstArrival: i === 0 ? fireFirstArrival : null
    });
  }

  if (drs.length === 0 && pts.length === 0 && !session.hasDrawings) {
    finishVisualSession(session.id, 8000);
  }
}

// -----------------------------------------------------------------------------
// Public cleanup
// -----------------------------------------------------------------------------
function clearBeacon() {
  sequenceToken++;
  clearAllTimeouts();

  cancelVisualSession();
  showGuidanceText("");
  clearHighlight();
  if (sparkleRafId !== null) {
    cancelAnimationFrame(sparkleRafId);
    sparkleRafId = null;
  }
  setSparkleSpeaking(false);
  captureScale = null;
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
function initBeaconOverlay() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureOverlay, { once: true });
  } else {
    ensureOverlay();
  }

  window.addEventListener("beforeunload", () => {
    clearBeacon();
    overlaySvg?.remove();
    overlaySvg = null;
    drawingsLayer = null;
    sparkleGroup = null;
    sparklePath = null;
    document.getElementById("beacon-overlay-styles")?.remove();
  });
}

initBeaconOverlay();

// =============================================================================
// Netra companion — dot UI, space-to-talk, memory, TTS, flags
// =============================================================================

const NETRA_STORAGE_LANG = "netraLanguage";
const EXCHANGE_CAP = 10; // last N exchanges = 2N messages

const BUBBLE_MS = 5000;

const NETRA_LANGS = [
  { flag: "🇺🇸", code: "EN", bcp: "en-US", angle: 0 },
  { flag: "🇮🇳", code: "HI", bcp: "hi-IN", angle: 40 },
  { flag: "🇮🇳", code: "TE", bcp: "te-IN", angle: 80 },
  { flag: "🇪🇸", code: "ES", bcp: "es-ES", angle: 120 },
  { flag: "🇧🇷", code: "PT", bcp: "pt-BR", angle: 160 },
  { flag: "🇩🇪", code: "DE", bcp: "de-DE", angle: 200 },
  { flag: "🇫🇷", code: "FR", bcp: "fr-FR", angle: 240 },
  { flag: "🇨🇳", code: "ZH", bcp: "zh-CN", angle: 280 },
  { flag: "🇸🇦", code: "AR", bcp: "ar-SA", angle: 320 },
];

/** @type {Array<{role: string, content: string}>} */
let conversationHistory = [];
/** @type {'IDLE'|'LISTENING'|'PROCESSING'|'SPEAKING'} */
let netraState = "IDLE";
let netraLangIndex = 0;
let spaceHeld = false;
let lastTapTime = 0;
let lastTapCleared = false;
let doubleTapTimer = 0;
let isDraggingDot = false;
let isLanguageOpen = false;
let dragStartX = 0;
let dragStartY = 0;
let dotStartRight = 24;
let dotStartBottom = 24;

/** @type {ReturnType<typeof setTimeout> | null} */
let labelResetTimer = null;
/** @type {SpeechRecognition | null} */
let netraRecognition = null;
let netraListenCancelled = false;
let netraPendingTranscript = "";
/** @type {HTMLAudioElement | null} */
let netraCurrentAudio = null;
/** @type {string | null} */
let netraCurrentAudioUrl = null;
/** @type {AudioBufferSourceNode | null} */
let netraWebAudioSource = null;
let audioUnlocked = false;
let netraAudioContext = null;

const SpeechRecCtor =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

// Sarah — warm, reassuring, conversational. Best for guided assistant UX.
const DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL";
// Adam — deep, friendly male alternative available via settings.
const DEFAULT_MULTILINGUAL_VOICE = "pNInz6obpgDQGcFmaJgB";
/** ElevenLabs model IDs (see https://elevenlabs.io/docs/overview/models) */
const ELEVEN_MODEL_MULTILINGUAL_V2 = "eleven_multilingual_v2";
const ELEVEN_MODEL_V3 = "eleven_v3";
const NETRA_VOICE_MAP = {
  "en-US": DEFAULT_VOICE,
  "hi-IN": DEFAULT_MULTILINGUAL_VOICE,
  "es-ES": DEFAULT_MULTILINGUAL_VOICE,
  "fr-FR": DEFAULT_MULTILINGUAL_VOICE,
  "zh-CN": DEFAULT_MULTILINGUAL_VOICE,
  "ar-SA": DEFAULT_MULTILINGUAL_VOICE,
  "pt-BR": DEFAULT_MULTILINGUAL_VOICE,
  "de-DE": DEFAULT_MULTILINGUAL_VOICE,
  "te-IN": DEFAULT_MULTILINGUAL_VOICE,
};

let netraEls = {
  root: null,
  chip: null,
  label: null,
  flagBtn: null,
  flagBadge: null,
  solar: null,
  orbit: null,
  planets: [],
  bars: null,
  bubbleT: null,
  bubbleR: null,
  dot: null,
  ring: null,
  aura: null,
  waves: null,
};

function cleanTextForNetra(text) {
  return String(text || "")
    .replace(/\[(?:POINT|DRAW):(?:[^\]"]*|"[^"]*")*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Prepare text for TTS: strip markdown artifacts, normalize for spoken delivery.
 * Called after cleanTextForNetra, before sending to ElevenLabs.
 */
function prepareSpeechText(text) {
  return String(text || "")
    // Strip markdown bold/italic
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    // Strip backtick code
    .replace(/`([^`]+)`/g, "$1")
    // Strip markdown links → keep label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Strip bullet/list markers at line starts
    .replace(/^[\s]*[-*•]\s+/gm, "")
    .replace(/^[\s]*\d+[.)]\s+/gm, "")
    // Strip heading markers
    .replace(/^#{1,6}\s+/gm, "")
    // Angle brackets / HTML-ish
    .replace(/<[^>]+>/g, "")
    // Multiple consecutive punctuation like "..."  keep as "..."
    .replace(/\.{4,}/g, "...")
    // Excessive exclamation / question marks
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")
    // Collapse whitespace
    .replace(/\s{2,}/g, " ")
    .trim();
}

function firstSentenceForBubble(text) {
  const t = cleanTextForNetra(text);
  if (!t) return "";
  const m = t.match(/[^.!?？！]+[.!?？！]?/);
  if (m) return m[0].trim();
  return t.length > 160 ? t.slice(0, 157) + "…" : t;
}

function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function netraDebug(...args) {
  console.log(...args);
  try {
    chrome.runtime.sendMessage({ action: "netraDebugLog", args }).catch(() => {});
  } catch {
    /* ignore debug bridge failures */
  }
}

function isEditableTarget(el) {
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return isEditableTarget(el.parentElement);
}

function setNetraState(next) {
  if (netraState === next) return;
  netraState = next;
  if (!netraEls.root) return;
  netraEls.root.dataset.netraState = next.toLowerCase();
  setSparkleSpeaking(next === "SPEAKING");
  if (next === "IDLE") {
    clearHighlight();
  }
}

function getNetraLanguage() {
  return NETRA_LANGS[netraLangIndex].bcp;
}

function setStatusLabel(text, opts = {}) {
  const { persist } = opts;
  if (!netraEls.label) return;
  if (labelResetTimer) {
    clearTimeout(labelResetTimer);
    labelResetTimer = null;
  }
  netraEls.label.textContent = text;
  if (persist) return;
  if (text === "Hold Space to ask" || !text) return;
  labelResetTimer = setTimeout(() => {
    if (netraEls.label && netraState === "IDLE") {
      netraEls.label.textContent = "Hold Space to ask";
    }
  }, 6000);
}

function showBubble(el, text) {
  if (!el || !text) return;
  el.textContent = text;
  el.classList.add("is-visible");
  if (el._dismiss) clearTimeout(el._dismiss);
  el._dismiss = setTimeout(() => {
    el.classList.remove("is-visible");
  }, BUBBLE_MS);
}

function injectNetraStyles() {
  if (document.getElementById("netra-companion-styles")) return;
  if (!document.getElementById("netra-inter-font")) {
    const link = document.createElement("link");
    link.id = "netra-inter-font";
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap";
    (document.head || document.documentElement).appendChild(link);
  }
  const style = document.createElement("style");
  style.id = "netra-companion-styles";
  style.textContent = `
    #netra-companion {
      position: fixed;
      z-index: 999993;
      right: 24px;
      bottom: 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      pointer-events: none;
      font-family: 'Inter', system-ui, sans-serif;
      letter-spacing: -0.01em;
      -webkit-font-smoothing: antialiased;
    }
    #netra-companion * {
      box-sizing: border-box;
      font-family: 'Inter', system-ui, sans-serif;
      letter-spacing: -0.01em;
      -webkit-font-smoothing: antialiased;
    }
    .netra-row {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 52px;
      height: 52px;
      pointer-events: auto;
    }
    .netra-label {
      order: 0;
      margin-bottom: 8px;
      padding: 6px 10px;
      max-width: 220px;
      text-align: center;
      font-size: 11px;
      font-weight: 500;
      color: ${NETRA_TEXT_MUTED};
      background: rgba(17,17,17,0.82);
      border: 1px solid ${NETRA_BORDER};
      border-radius: 999px;
      backdrop-filter: blur(14px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.32);
      pointer-events: none;
      z-index: 999995;
    }
    .netra-bubble {
      order: 1;
      max-width: 260px;
      margin-bottom: 8px;
      padding: 10px 14px;
      background: rgba(26,26,26,0.95);
      border: 1px solid ${NETRA_BORDER};
      color: rgba(255,255,255,0.8);
      font-size: 13px;
      font-weight: 400;
      line-height: 1.38;
      backdrop-filter: blur(16px);
      box-shadow: 0 12px 36px rgba(0,0,0,0.36);
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
      transition: opacity 200ms ease-out, transform 200ms ease-out;
      z-index: 999995;
    }
    .netra-bubble[data-kind="user"] {
      border-radius: 12px 12px 12px 4px;
    }
    .netra-bubble[data-kind="assistant"] {
      border-radius: 12px 12px 4px 12px;
    }
    .netra-bubble::before {
      display: inline-block;
      margin-right: 7px;
      color: ${NETRA_ACCENT};
      vertical-align: -1px;
    }
    .netra-bubble[data-kind="user"]::before {
      content: "•";
      font-size: 18px;
      line-height: 0;
    }
    .netra-bubble[data-kind="assistant"]::before {
      content: "";
      width: 12px;
      height: 12px;
      background: ${NETRA_ACCENT};
      -webkit-mask: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' fill='none' stroke='black' stroke-width='2'/%3E%3Ccircle cx='12' cy='12' r='3' fill='black'/%3E%3C/svg%3E") center / contain no-repeat;
      mask: url("data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' fill='none' stroke='black' stroke-width='2'/%3E%3Ccircle cx='12' cy='12' r='3' fill='black'/%3E%3C/svg%3E") center / contain no-repeat;
    }
    .netra-bubble.is-visible {
      opacity: 1;
      transform: translateY(0);
    }
    .netra-bubble:not(.is-visible) {
      transform: translateY(-4px);
      transition: opacity 150ms ease-in, transform 150ms ease-in;
    }
    .netra-chip {
      order: 2;
      position: relative;
      width: 52px;
      height: 52px;
    }
    .netra-dot-outer {
      position: relative;
      width: 52px;
      height: 52px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .netra-aura {
      position: absolute;
      inset: -4px;
      border-radius: 50%;
      border: 2px solid transparent;
      border-top-color: transparent;
      pointer-events: none;
    }
    .netra-dot {
      position: relative;
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: ${NETRA_BG};
      border: 1.5px solid rgba(255,255,255,0.12);
      color: ${NETRA_TEXT};
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow:
        0 0 0 1px rgba(32,184,205,0.15),
        0 8px 32px rgba(0,0,0,0.4),
        0 2px 8px rgba(0,0,0,0.3);
      cursor: pointer;
      transform-origin: center;
      user-select: none;
      -webkit-user-select: none;
      transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 200ms ease, border-color 200ms ease, box-shadow 200ms ease;
    }
    .netra-dot:hover {
      border-color: rgba(255,255,255,0.2);
    }
    .netra-dot:active {
      cursor: grabbing;
    }
    .netra-dot svg {
      width: 22px;
      height: 22px;
      filter: drop-shadow(0 0 6px rgba(32,184,205,0.18));
      transition: filter 200ms ease, transform 200ms ease;
    }
    .netra-flag-badge {
      position: absolute;
      right: -3px;
      bottom: -3px;
      width: 19px;
      height: 19px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: ${NETRA_SURFACE};
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 4px 12px rgba(0,0,0,0.35);
      font-size: 11px;
      z-index: 2;
      pointer-events: auto;
      cursor: pointer;
      transition: transform 200ms ease, border-color 200ms ease;
    }
    .netra-flag-badge:hover {
      transform: scale(1.08);
      border-color: rgba(255,255,255,0.2);
    }
    @keyframes netra-breathe {
      0%, 100% { transform: scale(1); border-color: rgba(255,255,255,0.12); }
      50% { transform: scale(1.04); border-color: rgba(255,255,255,0.25); }
    }
    #netra-companion[data-netra-state="idle"] .netra-dot {
      animation: netra-breathe 3s ease-in-out infinite;
    }
    #netra-companion[data-netra-state="listening"] .netra-dot {
      border-color: ${NETRA_ACCENT};
      box-shadow:
        0 0 0 1px rgba(32,184,205,0.2),
        0 0 20px rgba(32,184,205,0.4),
        0 8px 32px rgba(0,0,0,0.4),
        0 2px 8px rgba(0,0,0,0.3);
    }
    #netra-companion[data-netra-state="listening"] .netra-dot svg {
      filter: drop-shadow(0 0 10px rgba(32,184,205,0.55));
    }
    #netra-companion[data-netra-state="processing"] .netra-aura {
      border-top-color: ${NETRA_ACCENT};
      animation: netra-spin 1s linear infinite;
    }
    #netra-companion[data-netra-state="speaking"] .netra-dot {
      animation: netra-speaking-border 0.8s ease-in-out infinite alternate;
    }
    @keyframes netra-speaking-border {
      from { border-color: rgba(32,184,205,0.42); box-shadow: 0 0 0 1px rgba(32,184,205,0.15), 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.3); }
      to { border-color: ${NETRA_ACCENT}; box-shadow: 0 0 18px rgba(32,184,205,0.34), 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.3); }
    }
    @keyframes netra-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .netra-audio-bars {
      position: absolute;
      left: 50%;
      bottom: 62px;
      transform: translateX(-50%) translateY(8px);
      display: flex;
      align-items: center;
      gap: 3px;
      padding: 8px 12px;
      min-height: 36px;
      border-radius: 20px;
      background: rgba(17,17,17,0.9);
      backdrop-filter: blur(12px);
      border: 1px solid ${NETRA_BORDER};
      opacity: 0;
      pointer-events: none;
      transition: opacity 200ms ease, transform 200ms ease;
      box-shadow: 0 12px 30px rgba(0,0,0,0.32);
      z-index: 999995;
    }
    #netra-companion[data-netra-state="speaking"] .netra-audio-bars {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .netra-audio-bars span {
      width: 3px;
      height: 4px;
      border-radius: 2px;
      background: ${NETRA_ACCENT};
      opacity: 0.6;
      animation: netra-audio-bar var(--bar-speed) ease-in-out infinite alternate;
      animation-delay: var(--bar-delay);
    }
    @keyframes netra-audio-bar {
      from { height: 4px; opacity: 0.6; }
      to { height: var(--bar-max); opacity: 1; }
    }
    .netra-solar {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 0;
      height: 0;
      pointer-events: none;
      z-index: 999994;
    }
    #netra-companion.is-language-open .netra-solar {
      pointer-events: auto;
    }
    .netra-orbit {
      position: absolute;
      width: 140px;
      height: 140px;
      left: -70px;
      top: -70px;
      border-radius: 50%;
      border: 1px dashed rgba(255,255,255,0.06);
      opacity: 0;
      pointer-events: none;
      transition: opacity 200ms ease;
      animation: netra-spin 20s linear infinite;
    }
    #netra-companion.is-language-open .netra-orbit {
      opacity: 1;
    }
    .netra-planet {
      position: absolute;
      left: -16px;
      top: -16px;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: ${NETRA_SURFACE};
      border: 1px solid rgba(255,255,255,0.1);
      color: ${NETRA_TEXT};
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0;
      cursor: pointer;
      transform-origin: center;
      transform: translate(0,0) scale(0);
      opacity: 0;
      transition:
        transform 350ms cubic-bezier(0.34, 1.56, 0.64, 1),
        opacity 220ms ease,
        border-color 200ms ease,
        box-shadow 200ms ease;
      box-shadow: 0 10px 26px rgba(0,0,0,0.32);
      z-index: 999994;
    }
    .netra-planet-flag {
      font-size: 18px;
      line-height: 15px;
    }
    .netra-planet-code {
      font-size: 8px;
      font-weight: 500;
      line-height: 9px;
      color: ${NETRA_TEXT_MUTED};
    }
    #netra-companion.is-language-open .netra-planet {
      transform: translate(var(--orbit-x), var(--orbit-y)) scale(1);
      opacity: 1;
    }
    .netra-planet.is-selected {
      border: 1.5px solid ${NETRA_ACCENT};
      box-shadow: 0 0 8px rgba(32,184,205,0.4), 0 10px 26px rgba(0,0,0,0.32);
    }
    #netra-companion.is-language-open .netra-planet.is-selected {
      transform: translate(var(--orbit-x), var(--orbit-y)) scale(1.1);
    }
    .netra-planet.is-popping {
      transform: translate(var(--orbit-x), var(--orbit-y)) scale(1.2) !important;
    }
    #netra-companion.is-dragging {
      opacity: 0.8;
    }
    #netra-companion.is-dragging .netra-dot {
      transform: scale(0.95);
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function readDotPosition() {
  try {
    const raw = localStorage.getItem("netraDotPosition");
    if (!raw) return;
    const p = JSON.parse(raw);
    if (typeof p.right === "number" && typeof p.bottom === "number") {
      return { right: p.right, bottom: p.bottom };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeDotPosition(right, bottom) {
  try {
    localStorage.setItem("netraDotPosition", JSON.stringify({ right, bottom }));
  } catch {
    /* ignore */
  }
}

function applyDotPosition() {
  const r = netraEls.root;
  if (!r) return;
  r.style.right = `${dotStartRight}px`;
  r.style.bottom = `${dotStartBottom}px`;
}

function createNetraDom() {
  injectNetraStyles();
  if (document.getElementById("netra-companion")) return;

  const saved = readDotPosition();
  if (saved) {
    dotStartRight = saved.right;
    dotStartBottom = saved.bottom;
  }

  const root = document.createElement("div");
  root.id = "netra-companion";
  root.setAttribute("data-netra-state", "idle");
  // Apply saved position directly — applyDotPosition() requires netraEls.root
  // which isn't assigned yet, so write to root directly here.
  root.style.right = `${dotStartRight}px`;
  root.style.bottom = `${dotStartBottom}px`;

  const label = document.createElement("div");
  label.className = "netra-label";
  label.textContent = "Hold Space to ask";

  const bubbleT = document.createElement("div");
  bubbleT.className = "netra-bubble";
  bubbleT.dataset.kind = "user";
  const bubbleR = document.createElement("div");
  bubbleR.className = "netra-bubble";
  bubbleR.dataset.kind = "assistant";

  const row = document.createElement("div");
  row.className = "netra-row";

  const chip = document.createElement("div");
  chip.className = "netra-chip";

  const outer = document.createElement("div");
  outer.className = "netra-dot-outer";

  const aura = document.createElement("div");
  aura.className = "netra-aura";

  const bars = document.createElement("div");
  bars.className = "netra-audio-bars";
  [
    ["18px", "0.5s", "0s"],
    ["24px", "0.7s", "0.08s"],
    ["20px", "0.4s", "0.16s"],
    ["22px", "0.6s", "0.24s"],
    ["16px", "0.55s", "0.3s"],
  ].forEach(([max, speed, delay]) => {
    const bar = document.createElement("span");
    bar.style.setProperty("--bar-max", max);
    bar.style.setProperty("--bar-speed", speed);
    bar.style.setProperty("--bar-delay", delay);
    bars.appendChild(bar);
  });

  const dot = document.createElement("div");
  dot.className = "netra-dot";
  dot.innerHTML = `
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
            fill="none"
            stroke="${NETRA_ACCENT}"
            stroke-width="1.5"
            stroke-linecap="round"/>
      <circle cx="12" cy="12" r="3"
              fill="none"
              stroke="${NETRA_ACCENT}"
              stroke-width="1.5"/>
      <circle cx="12" cy="12" r="1" fill="${NETRA_ACCENT}"/>
    </svg>
  `;
  dot.setAttribute("role", "button");
  dot.setAttribute("aria-label", "Netra");

  const flagBadge = document.createElement("div");
  flagBadge.className = "netra-flag-badge";

  const solar = document.createElement("div");
  solar.className = "netra-solar";
  const orbit = document.createElement("div");
  orbit.className = "netra-orbit";
  solar.appendChild(orbit);
  const planets = NETRA_LANGS.map((lang, i) => {
    const p = document.createElement("button");
    p.type = "button";
    p.className = "netra-planet";
    p.dataset.langIndex = String(i);
    p.setAttribute("aria-label", `Select ${lang.code}`);
    const rad = ((lang.angle - 90) * Math.PI) / 180;
    const x = Math.cos(rad) * 70;
    const y = Math.sin(rad) * 70;
    p.style.setProperty("--orbit-x", `${x}px`);
    p.style.setProperty("--orbit-y", `${y}px`);
    p.style.transitionDelay = `${i * 25}ms`;
    p.innerHTML = `
      <span class="netra-planet-flag">${lang.flag}</span>
      <span class="netra-planet-code">${lang.code}</span>
    `;
    solar.appendChild(p);
    return p;
  });

  outer.appendChild(aura);
  outer.appendChild(dot);
  outer.appendChild(flagBadge);
  chip.appendChild(outer);
  chip.appendChild(bars);
  chip.appendChild(solar);
  row.appendChild(chip);
  root.appendChild(label);
  root.appendChild(bubbleT);
  root.appendChild(bubbleR);
  root.appendChild(row);
  (document.body || document.documentElement).appendChild(root);

  netraEls = {
    root,
    chip,
    label,
    flagBtn: flagBadge,
    flagBadge,
    solar,
    orbit,
    planets,
    bars,
    bubbleT,
    bubbleR,
    dot,
    ring: aura,
    aura,
    waves: bars
  };
}

function stopNetraTts() {
  if (netraWebAudioSource) {
    try {
      netraWebAudioSource.stop(0);
    } catch {
      /* may already be stopped */
    }
    try {
      netraWebAudioSource.disconnect();
    } catch {
      /* ignore */
    }
    netraWebAudioSource = null;
  }
  if (netraCurrentAudio) {
    netraCurrentAudio.pause();
    netraCurrentAudio.src = "";
    netraCurrentAudio.onended = null;
    netraCurrentAudio.onerror = null;
    netraCurrentAudio = null;
  }
  if (netraCurrentAudioUrl) {
    if (netraCurrentAudioUrl.startsWith("blob:")) {
      URL.revokeObjectURL(netraCurrentAudioUrl);
    }
    netraCurrentAudioUrl = null;
  }
}

async function getStorageKey(k) {
  const o = await chrome.storage.local.get(k);
  return o[k];
}

async function getWorkerUrlForTts() {
  const url = await getStorageKey("workerUrl");
  return typeof url === "string" && url.trim() ? url.trim().replace(/\/+$/, "") : null;
}

/**
 * Hindi: `eleven_v3` + `language_code: hi` — most natural prosody; falls back in netraSpeak on error.
 * Other locales: keep `eleven_multilingual_v2` (stable, 10k+ char limit for long rarer cases).
 * @param {string} bcp - BCP-47 e.g. hi-IN
 * @param {string} text - cleaned
 * @returns {Record<string, unknown>}
 */
function buildElevenTtsBody(bcp, text) {
  const tag = (bcp || "").toLowerCase().trim();
  if (tag.startsWith("hi")) {
    return {
      text,
      model_id: ELEVEN_MODEL_V3,
      language_code: "hi",
      voice_settings: {
        stability: 0.38,
        similarity_boost: 0.78,
        style: 0.4,
        use_speaker_boost: false
      }
    };
  }
  return {
    text,
    model_id: ELEVEN_MODEL_MULTILINGUAL_V2,
    voice_settings: {
      stability: 0.35,
      similarity_boost: 0.80,
      style: 0.45,
      use_speaker_boost: false
    }
  };
}

async function unlockAudio(timeoutMs = 250) {
  if (audioUnlocked) return true;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    const ctx = netraAudioContext || new Ctx();
    netraAudioContext = ctx;
    await Promise.race([
      ctx.resume(),
      new Promise((resolve) => window.setTimeout(resolve, timeoutMs))
    ]);
    if (ctx.state !== "running") {
      return false;
    }
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    audioUnlocked = true;
    window.__netraTtsAudioPrimed = true;
    console.log("[Netra] Audio unlocked");
    return true;
  } catch (e) {
    console.log("[Netra] Audio unlock failed:", e);
    return false;
  }
}

/**
 * ElevenLabs from the same tab (host_permissions for api.elevenlabs.io). Prefer this.
 * @param {string} voiceId
 * @param {Record<string, unknown>} ttsBody
 * @returns {Promise<{ success: boolean, ab?: ArrayBuffer, status?: number, error?: string }>}
 */
async function ttsFetchInContent(voiceId, ttsBody) {
  const apiKey =
    (await getStorageKey("elevenLabsApiKey")) ||
    (await getStorageKey("elevenLabsKey"));
  if (!apiKey) {
    return { success: false, error: "no_key" };
  }
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    voiceId
  )}/stream`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "xi-api-key":  apiKey,
        "Content-Type": "application/json",
        Accept:         "audio/mpeg"
      },
      body: JSON.stringify(ttsBody),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { success: false, status: res.status, error: t };
    }
    return { success: true, ab: await res.arrayBuffer() };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e?.name === "AbortError") {
      console.warn("[Netra Voice] TTS timed out after 8s");
      return { success: false, error: "timeout" };
    }
    return { success: false, error: String(e?.message || e) };
  }
}

/**
 * Same fetch in the service worker, binary returned via port (avoids message size
 * limits and unreliable sendMessage responses for big MP3s).
 * @param {string} voiceId
 * @param {Record<string, unknown>} ttsBody
 */
function ttsFetchViaPort(voiceId, ttsBody) {
  return new Promise((resolve) => {
    let done = false;
    /** @type {chrome.runtime.Port | null} */
    let port = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        port?.disconnect();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    try {
      port = chrome.runtime.connect({ name: "netraTts" });
    } catch (e) {
      finish({ success: false, error: String(e) });
      return;
    }
    const to = setTimeout(() => {
      finish({ success: false, error: "TTS (background) timed out" });
    }, 8_000);
    port.onMessage.addListener((m) => {
      clearTimeout(to);
      if (m.ok && m.ab) {
        finish({ success: true, ab: m.ab });
      } else {
        finish({
          success: false,
          status: m.status,
          error:  m.error || m.err || "TTS failed"
        });
      }
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(to);
      if (chrome.runtime.lastError) {
        finish({
          success: false,
          error: chrome.runtime.lastError.message
        });
      } else if (!done) {
        finish({ success: false, error: "Disconnected before audio" });
      }
    });
    try {
      port.postMessage({ voiceId, ttsBody });
    } catch (e) {
      clearTimeout(to);
      finish({ success: false, error: String(e) });
    }
  });
}

async function ttsFetchViaWorker(voiceId, text) {
  const workerUrl = await getWorkerUrlForTts();
  if (!workerUrl) {
    return { success: false, error: "no_worker_url" };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${workerUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceId, text }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const error = await res.text().catch(() => res.statusText);
      return { success: false, status: res.status, error };
    }
    const ab = await res.arrayBuffer();
    netraDebug("[Netra] TTS worker fetch OK, bytes:", ab.byteLength);
    return { success: true, ab };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e?.name === "AbortError") {
      return { success: false, error: "worker_tts_timeout" };
    }
    return { success: false, error: String(e?.message || e) };
  }
}

function buildElevenTtsV2FallbackBody(fromBody) {
  const out = { ...fromBody, model_id: ELEVEN_MODEL_MULTILINGUAL_V2 };
  delete out.language_code;
  out.voice_settings = {
    stability: 0.35,
    similarity_boost: 0.80,
    style: 0.45,
    use_speaker_boost: false
  };
  return out;
}

async function fetchNetraTtsAudio(voiceId, primaryBody, spokenText, opts = {}) {
  const { forceV2 = false, preferWorker = false } = opts;
  const requestBody = forceV2
    ? buildElevenTtsV2FallbackBody(primaryBody)
    : primaryBody;

  if (preferWorker) {
    const workerTts = await ttsFetchViaWorker(voiceId, spokenText || requestBody.text || "");
    if (workerTts.success && workerTts.ab) return workerTts;
  }

  let tts = await ttsFetchInContent(voiceId, requestBody);
  if (tts.success && tts.ab) {
    netraDebug("[Netra] TTS in-page fetch OK, bytes:", tts.ab.byteLength);
    return tts;
  }

  console.warn("[Netra] TTS in-page failed:", tts);
  tts = await ttsFetchViaPort(voiceId, requestBody);
  if (tts.success && tts.ab) {
    netraDebug("[Netra] TTS background port OK, bytes:", tts.ab.byteLength);
    return tts;
  }

  if (!forceV2 && primaryBody.model_id === ELEVEN_MODEL_V3) {
    const v2 = buildElevenTtsV2FallbackBody(primaryBody);
    console.warn("[Netra] TTS: trying multilingual v2");
    tts = await ttsFetchInContent(voiceId, v2);
    if (!tts.success || !tts.ab) {
      tts = await ttsFetchViaPort(voiceId, v2);
    }
    if (tts.success && tts.ab) {
      netraDebug("[Netra] TTS multilingual v2 fallback OK, bytes:", tts.ab.byteLength);
    }
  }

  if (!tts.success || !tts.ab) {
    console.warn("[Netra] TTS extension path failed; trying worker /tts:", tts);
    tts = await ttsFetchViaWorker(voiceId, spokenText || primaryBody.text || "");
  }

  return tts;
}

/**
 * @param {ArrayBuffer} ab
 * @returns {{ kind: string, hint: string, rejectPlayback: boolean }}
 */
function sniffTtsBuffer(ab) {
  if (!ab || ab.byteLength < 2) {
    return { kind: "empty", hint: "no bytes", rejectPlayback: true };
  }
  const u8 = new Uint8Array(ab, 0, Math.min(16, ab.byteLength));
  const a = u8[0];
  const b = u8[1];
  if (a === 0x49 && b === 0x44 && u8[2] === 0x33) {
    return { kind: "mp3-id3", hint: "ID3 tag", rejectPlayback: false };
  }
  if (a === 0xff && (b & 0xe0) === 0xe0) {
    return { kind: "mpeg", hint: "MPEG frame sync", rejectPlayback: false };
  }
  const head = new TextDecoder("utf-8", { fatal: false }).decode(
    ab.slice(0, 160)
  );
  const t = head.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    return { kind: "json", hint: head.slice(0, 200), rejectPlayback: true };
  }
  if (
    t.startsWith("<!") ||
    t.startsWith("<?xml") ||
    t.toLowerCase().startsWith("<html")
  ) {
    return { kind: "html", hint: head.slice(0, 200), rejectPlayback: true };
  }
  const hex = Array.from(u8)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join(" ");
  return { kind: "unknown", hint: `${hex} | ${head.slice(0, 80)}`, rejectPlayback: false };
}

/**
 * @param {ArrayBuffer} ab
 * @returns {Promise<boolean>}
 */
function tryPlayNetraWithWebAudio(ab) {
  return new Promise((resolve) => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      resolve(false);
      return;
    }
    const finish = (ok) => {
      stopNetraTts();
      setNetraState("IDLE");
      setStatusLabel("Hold Space to ask", {});
      resolve(ok);
    };
    (async () => {
      const ctx = netraAudioContext || new Ctx();
      netraAudioContext = ctx;
      if (ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch (e) {
          netraDebug(
            "[Netra Voice] AudioContext resume failed:",
            String(e?.message || e)
          );
        }
      }
      let decoded;
      try {
        decoded = await ctx.decodeAudioData(ab.slice(0));
      } catch (e) {
        netraDebug(
          "[Netra Voice] decodeAudioData failed:",
          String(e?.message || e)
        );
        resolve(false);
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(ctx.destination);
      netraWebAudioSource = src;
      netraCurrentAudio = null;
      src.onended = () => {
        netraDebug("[Netra Voice] WebAudio playback ended");
        finish(true);
      };
      try {
        src.start(0);
      } catch (e) {
        netraDebug(
          "[Netra Voice] WebAudio start failed:",
          String(e?.message || e)
        );
        finish(false);
      }
    })();
  });
}

/**
 * @param {ArrayBuffer} ab
 * @returns {Promise<boolean>}
 */
function tryPlayNetraWithHtmlAudio(ab) {
  return new Promise((resolve) => {
    const blobUrl = URL.createObjectURL(
      new Blob([ab], { type: "audio/mpeg" })
    );
    netraCurrentAudioUrl = blobUrl;
    const audio = new Audio(blobUrl);
    audio.preload = "auto";
    netraCurrentAudio = audio;
    setNetraState("SPEAKING");

    const finish = (ok) => {
      stopNetraTts();
      setNetraState("IDLE");
      setStatusLabel("Hold Space to ask", {});
      resolve(ok);
    };

    audio.onended = () => {
      netraDebug("[Netra Voice] audio playback ended");
      finish(true);
    };
    audio.onerror = () => {
      console.warn("[Netra Voice] audio element error");
      netraDebug("[Netra Voice] audio element error");
      finish(false);
    };
    audio.play().catch((e) => {
      console.warn("[Netra] audio.play() blocked:", e);
      netraDebug(
        "[Netra Voice] audio.play blocked:",
        String(e?.message || e)
      );
      finish(false);
    });
  });
}

/**
 * @param {ArrayBuffer} ab
 * @returns {Promise<boolean>}
 */
async function playNetraAudioBuffer(ab) {
  const sniff = sniffTtsBuffer(ab);
  const hint =
    sniff.hint && sniff.hint.length > 200
      ? `${sniff.hint.slice(0, 200)}…`
      : sniff.hint;
  netraDebug("[Netra Voice] TTS buffer kind:", sniff.kind, hint);
  if (sniff.rejectPlayback) {
    return false;
  }
  setNetraState("SPEAKING");
  // ElevenLabs output is unchanged: <audio> is the default path; Web Audio only
  // decodes the same MP3 bytes if the element cannot play the blob (recovery).
  if (await tryPlayNetraWithHtmlAudio(ab)) {
    return true;
  }
  netraDebug(
    "[Netra Voice] <audio> failed; WebAudio fallback (same MP3, different decode path)"
  );
  setNetraState("SPEAKING");
  if (await tryPlayNetraWithWebAudio(ab)) {
    return true;
  }
  return false;
}

async function netraSpeak(text, language) {
  const trimmed = cleanTextForNetra(text);
  netraDebug("[Netra Voice] netraSpeak called, chars:", trimmed.length, "language:", language);
  setStatusLabel("Preparing voice…", { persist: true });
  if (!trimmed) {
    setNetraState("IDLE");
    setStatusLabel("Hold Space to ask", {});
    return;
  }
  const hasKey = await (async () => {
    const a = await getStorageKey("elevenLabsApiKey");
    const b = await getStorageKey("elevenLabsKey");
    return !!(a || b);
  })();
  if (!hasKey) {
    setNetraState("IDLE");
    setStatusLabel("Hold Space to ask", {});
    showBubble(netraEls.bubbleR, firstSentenceForBubble(trimmed) || trimmed.slice(0, 220));
    return;
  }
  await unlockAudio(200);
  window.speechSynthesis?.cancel();
  stopNetraTts();
  setNetraState("SPEAKING");
  const spokenText = truncateForSpeech(prepareSpeechText(trimmed));
  setStatusLabel(wordsPreview(spokenText, 5), { persist: true });
  const voiceId = NETRA_VOICE_MAP[language] || DEFAULT_MULTILINGUAL_VOICE;
  const primary = buildElevenTtsBody(language, spokenText);
  let tts = await fetchNetraTtsAudio(voiceId, primary, spokenText);
  if (!tts.success || !tts.ab) {
    console.warn("[Netra Voice] TTS failed, showing text only:", tts?.error);
    netraDebug("[Netra Voice] TTS failed:", tts?.status || "", tts?.error || "");
    setNetraState("IDLE");
    setStatusLabel("Hold Space to ask", {});
    showBubble(netraEls.bubbleR, firstSentenceForBubble(trimmed) || trimmed.slice(0, 220));
    return;
  }

  setStatusLabel("Playing voice…", { persist: true });
  let didPlay = await playNetraAudioBuffer(tts.ab);
  if (!didPlay) {
    await unlockAudio();
    await delay(100);
    netraDebug("[Netra Voice] primary audio could not play; trying browser-safe v2/worker fallback");
    tts = await fetchNetraTtsAudio(voiceId, primary, spokenText, {
      forceV2: primary.model_id === ELEVEN_MODEL_V3,
      preferWorker: true
    });
    if (tts.success && tts.ab) {
      didPlay = await playNetraAudioBuffer(tts.ab);
    }
  }

  if (!didPlay) {
    showBubble(netraEls.bubbleR, firstSentenceForBubble(trimmed) || trimmed.slice(0, 220));
    netraDebug("[Netra Voice] playback failed after retry");
  }
}

async function speakReplyOnce(reply, language, sessionId) {
  const cleaned = cleanTextForNetra(reply);
  if (!cleaned) return;
  const key = `${language}:${cleaned}`;
  if (lastSpokenReplyKey === key) {
    console.log("[Netra Voice] skipping duplicate speech");
    return;
  }
  lastSpokenReplyKey = key;
  const sentence = firstSentenceForBubble(cleaned);
  if (sentence) {
    showBubble(netraEls.bubbleR, sentence);
  }
  await netraSpeak(cleaned, language);
  finishVisualSession(sessionId || activeVisualSession?.id, 1800);
}

function truncateForSpeech(text, maxWords = 150) {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "…";
}


function wordsPreview(text, n) {
  const w = String(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!w.length) return "";
  return w.slice(0, n).join(" ");
}

function netraFlushFinalTranscript() {
  const text = netraPendingTranscript.trim();
  netraPendingTranscript = "";
  if (!text) {
    if (getNetraState() === "LISTENING") setNetraState("IDLE");
    setStatusLabel("Hold Space to ask", {});
    return;
  }
  void runNetraPipeline(text);
}

function getNetraState() {
  return netraState;
}

function startNetraListening() {
  void unlockAudio(500);
  if (!SpeechRecCtor) {
    setStatusLabel("Speech not available", {});
    return;
  }
  netraListenCancelled = false;
  stopNetraTts();
  if (netraRecognition) {
    try {
      netraRecognition.abort();
    } catch {
      /* ignore */
    }
    netraRecognition = null;
  }
  netraPendingTranscript = "";
  const instance = new SpeechRecCtor();
  netraRecognition = instance;
  instance.continuous = true;
  instance.interimResults = true;
  instance.lang = getNetraLanguage();
  instance.onresult = (event) => {
    if (netraRecognition !== instance) return;
    const transcript = Array.from(event.results)
      .map((r) => r[0]?.transcript ?? "")
      .join("");
    netraPendingTranscript = transcript;
    if (transcript) {
      setStatusLabel("Listening…", { persist: true });
      showBubble(netraEls.bubbleT, transcript);
    }
  };
  instance.onerror = (e) => {
    if (e.error === "aborted" || e.error === "no-speech") return;
    if (netraRecognition === instance) {
      setNetraState("IDLE");
    }
  };
  instance.onend = () => {
    if (netraRecognition !== instance) return;
    netraRecognition = null;
    if (getNetraState() === "LISTENING") {
      if (netraListenCancelled) {
        netraListenCancelled = false;
        netraPendingTranscript = "";
        setNetraState("IDLE");
        setStatusLabel("Hold Space to ask", {});
        return;
      }
      setNetraState("IDLE");
      netraFlushFinalTranscript();
    }
  };
  try {
    instance.start();
    setNetraState("LISTENING");
    setStatusLabel("Listening…", { persist: true });
  } catch (e) {
    console.error("[Netra] recognition.start", e);
    netraRecognition = null;
    setNetraState("IDLE");
  }
}

function stopNetraListening() {
  if (!netraRecognition) {
    if (getNetraState() === "LISTENING") setNetraState("IDLE");
    return;
  }
  const inst = netraRecognition;
  try {
    inst.stop();
  } catch (e) {
    console.error("[Netra] recognition.stop", e);
    if (netraRecognition === inst) netraRecognition = null;
    setNetraState("IDLE");
  }
}

function netraAbortListening() {
  netraListenCancelled = true;
  netraPendingTranscript = "";
  if (!netraRecognition) {
    if (getNetraState() === "LISTENING") setNetraState("IDLE");
    return;
  }
  const inst = netraRecognition;
  try {
    inst.abort();
  } catch (e) {
    if (netraRecognition === inst) netraRecognition = null;
    setNetraState("IDLE");
  }
}

async function runNetraPipeline(transcriptRaw) {
  const transcript = (transcriptRaw || "").trim();
  if (!transcript) {
    setStatusLabel("Nothing heard", {});
    return;
  }
  if (getNetraState() === "SPEAKING" || getNetraState() === "PROCESSING") {
    return;
  }
  const visualSession = beginVisualSession();
  setNetraState("PROCESSING");
  setStatusLabel("Thinking…", { persist: true });
  const lang = getNetraLanguage();
  try {
    // Hide Netra's own UI so it doesn't appear in the screenshot and confuse Claude.
    // Two rAF cycles guarantee the browser has repainted before the capture IPC lands.
    const netraRoot   = document.getElementById("netra-companion");
    const beaconLayer = document.getElementById("beacon-overlay");
    const label       = document.getElementById("netra-element-label");
    if (netraRoot)   netraRoot.style.visibility   = "hidden";
    if (beaconLayer) beaconLayer.style.visibility = "hidden";
    if (label)       label.style.visibility       = "hidden";
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const cap = await sendRuntimeMessage({ action: "captureScreen" });

    if (netraRoot)   netraRoot.style.visibility   = "";
    if (beaconLayer) beaconLayer.style.visibility = "";
    if (label)       label.style.visibility       = "";

    if (!cap?.success) {
      throw new Error(cap?.error || "Screen capture failed");
    }

    let screenMeta = null;
    try {
      const { w, h } = await measureScreenshotDataUrl(cap.screenshot);
      const cssW = window.innerWidth;
      const cssH = window.innerHeight;
      captureScale = { imgW: w, imgH: h, cssW, cssH };
      screenMeta = {
        imageWidth: w,
        imageHeight: h,
        cssWidth: cssW,
        cssHeight: cssH
      };
    } catch (e) {
      console.warn("[Netra] Could not measure screenshot for coordinate mapping:", e);
      captureScale = null;
    }

    const domContext = collectInteractiveElements();

    const ai = await sendRuntimeMessage({
      action: "sendToNetra",
      transcript,
      language: lang,
      screenshot: cap.screenshot,
      conversationHistory: conversationHistory.slice(-(EXCHANGE_CAP * 2)),
      screenMeta,
      domContext
    });
    if (!ai?.success) {
      throw new Error(ai?.error || "Request failed");
    }
    const reply = cleanTextForNetra(ai.response || "");
    console.log("[Netra Voice] AI reply ready, chars:", reply.length);
    if (transcript) {
      conversationHistory.push(
        { role: "user", content: transcript },
        { role: "assistant", content: reply }
      );
      if (conversationHistory.length > EXCHANGE_CAP * 2) {
        conversationHistory = conversationHistory.slice(-(EXCHANGE_CAP * 2));
      }
    }
    await speakReplyOnce(reply, lang, visualSession.id);
  } catch (err) {
    console.error("[Netra] pipeline", err);
    setNetraState("IDLE");
    setStatusLabel("Hold Space to ask", {});
    showBubble(
      netraEls.bubbleR,
      err?.message || "Something went wrong"
    );
    finishVisualSession(visualSession.id, 8000);
  } finally {
    if (getNetraState() === "PROCESSING") {
      setNetraState("IDLE");
    }
  }
}

function onNetraKeyDown(e) {
  if (e.code === "Escape") {
    cancelAutoFollow();
    clearHighlight();
    if (getNetraState() === "LISTENING") {
      e.preventDefault();
      spaceHeld = false;
      netraAbortListening();
      setStatusLabel("Cancelled", {});
      return;
    }
  }
  if (e.code !== "Space") return;
  if (e.repeat) return;
  if (isEditableTarget(e.target)) return;
  e.preventDefault();
  cancelAutoFollow();
  void unlockAudio(500);
  if (getNetraState() !== "IDLE" && getNetraState() !== "LISTENING") return;
  spaceHeld = true;
  startNetraListening();
}

function onNetraKeyUp(e) {
  if (e.code !== "Space") return;
  if (isEditableTarget(e.target)) return;
  e.preventDefault();
  void unlockAudio(500);
  if (!spaceHeld) return;
  spaceHeld = false;
  if (getNetraState() === "LISTENING") {
    stopNetraListening();
  }
}

function openSettingsTab() {
  // Content scripts cannot call chrome.tabs.create() — route through background.js
  chrome.runtime.sendMessage({ action: "openSettings" }).catch((e) => {
    console.warn("[Netra] Could not open settings:", e);
  });
}

function handleDotClick(e) {
  e.preventDefault();
  e.stopPropagation();
  if (isLanguageOpen) {
    setLanguageSolarOpen(false);
    return;
  }
  const now = Date.now();
  if (now - lastTapTime < 400 && !lastTapCleared) {
    window.clearTimeout(doubleTapTimer);
    lastTapCleared = true;
    lastTapTime = 0;
    conversationHistory = [];
    setStatusLabel("Fresh start!", { persist: true });
    if (labelResetTimer) clearTimeout(labelResetTimer);
    labelResetTimer = setTimeout(() => {
      if (netraEls.label && netraState === "IDLE") {
        netraEls.label.textContent = "Hold Space to ask";
      }
    }, 3000);
    return;
  }
  lastTapCleared = false;
  lastTapTime = now;
  doubleTapTimer = window.setTimeout(() => {
    if (isDraggingDot) return;
    if (getNetraState() === "IDLE" && !lastTapCleared) {
      setLanguageSolarOpen(true);
    }
  }, 350);
}

function syncSelectedLanguageVisuals() {
  const cur = NETRA_LANGS[netraLangIndex];
  if (netraEls.flagBadge) {
    netraEls.flagBadge.textContent = cur.flag;
  }
  if (Array.isArray(netraEls.planets)) {
    netraEls.planets.forEach((planet, i) => {
      planet.classList.toggle("is-selected", i === netraLangIndex);
    });
  }
}

function setLanguageSolarOpen(open) {
  isLanguageOpen = open;
  netraEls.root?.classList.toggle("is-language-open", open);
}

function onFlagClick(e) {
  e.stopPropagation();
  e.preventDefault();
  setLanguageSolarOpen(!isLanguageOpen);
}

function onPlanetClick(e) {
  e.stopPropagation();
  e.preventDefault();
  const btn = e.currentTarget;
  const idx = Number(btn?.dataset?.langIndex);
  if (!Number.isInteger(idx) || !NETRA_LANGS[idx]) return;
  netraLangIndex = idx;
  btn.classList.add("is-popping");
  syncSelectedLanguageVisuals();
  chrome.storage.local
    .set({ [NETRA_STORAGE_LANG]: NETRA_LANGS[netraLangIndex].bcp })
    .catch(() => {});
  window.setTimeout(() => {
    btn.classList.remove("is-popping");
    setLanguageSolarOpen(false);
  }, 160);
}

function onDotPointerDown(e) {
  isDraggingDot = false;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  if (!netraEls.root) return;
  const r = netraEls.root.getBoundingClientRect();
  dotStartRight = window.innerWidth - r.right;
  dotStartBottom = window.innerHeight - r.bottom;
}

function onDotPointerMove(e) {
  if (e.buttons !== 1) return;
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  if (Math.hypot(dx, dy) > 6) {
    isDraggingDot = true;
    netraEls.root?.classList.add("is-dragging");
    setLanguageSolarOpen(false);
    window.clearTimeout(doubleTapTimer);
  }
  if (!isDraggingDot) return;
  e.preventDefault();
  dotStartRight = Math.max(
    8,
    Math.min(
      window.innerWidth - 56,
      dotStartRight - dx
    )
  );
  dotStartBottom = Math.max(
    8,
    Math.min(
      window.innerHeight - 56,
      dotStartBottom - dy
    )
  );
  applyDotPosition();
  dragStartX = e.clientX;
  dragStartY = e.clientY;
}

function onDotPointerUp() {
  if (isDraggingDot) {
    writeDotPosition(dotStartRight, dotStartBottom);
  }
  netraEls.root?.classList.remove("is-dragging");
  window.setTimeout(() => {
    isDraggingDot = false;
  }, 0);
}

async function loadNetraLanguage() {
  try {
    const o = await chrome.storage.local.get(NETRA_STORAGE_LANG);
    const b = o[NETRA_STORAGE_LANG];
    if (b && typeof b === "string") {
      const idx = NETRA_LANGS.findIndex((x) => x.bcp === b);
      if (idx >= 0) {
        netraLangIndex = idx;
      }
    }
  } catch {
    /* ignore */
  }
  syncSelectedLanguageVisuals();
}

function initNetraCompanion() {
  if (window !== window.top) return;
  if (location.protocol === "chrome-extension:") return;
  if (location.protocol === "chrome:") return;

  const go = () => {
    createNetraDom();
    void loadNetraLanguage();
    void unlockAudio(150);
    document.addEventListener("keydown", () => void unlockAudio(500), { capture: true });
    document.addEventListener("click", () => void unlockAudio(500), { capture: true });
    document.addEventListener("mousedown", () => void unlockAudio(500), { capture: true });
    document.addEventListener("keydown", onNetraKeyDown, true);
    document.addEventListener("keyup", onNetraKeyUp, true);
    document.addEventListener("click", onDocumentClickForHighlight, { capture: true });
    const { flagBtn, dot, planets } = netraEls;
    if (flagBtn) {
      flagBtn.addEventListener("click", onFlagClick);
    }
    if (Array.isArray(planets)) {
      planets.forEach((planet) => planet.addEventListener("click", onPlanetClick));
    }
    if (dot) {
      dot.addEventListener("click", handleDotClick);
      dot.addEventListener("pointerdown", onDotPointerDown, true);
    }
    window.addEventListener("pointermove", onDotPointerMove, true);
    window.addEventListener("pointerup", onDotPointerUp, true);

    resumeAutoFollowAfterNavigation();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", go, { once: true });
  } else {
    go();
  }
}

initNetraCompanion();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "beaconStreamText" && typeof message.text === "string") {
    if (getNetraState() !== "SPEAKING") {
      setNetraState("PROCESSING");
    }
    setStatusLabel(message.text, { persist: true });
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "beaconError") {
    setNetraState("IDLE");
    setStatusLabel("Hold Space to ask", {});
    if (message.message) {
      showBubble(netraEls.bubbleR, message.message);
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "beaconResponse") {
    const { text, points, draws } = message;
    void (async () => {
      try {
        await runBeaconSequence({
          text: text || "",
          points: points || [],
          draws: draws || []
        });
        if (message.isFinal && text) {
          const reply = cleanTextForNetra(text);
          netraDebug("[Netra CS] final beaconResponse received, chars:", reply.length);
          void speakReplyOnce(reply, getNetraLanguage(), activeVisualSession?.id);
        }
        sendResponse({ success: true });
      } catch (err) {
        console.error("[Netra CS] beaconResponse failed:", err);
        sendResponse({ success: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (message.action === "ping") {
    sendResponse({ alive: true });
    return false;
  }

  if (message.action === "screenshotCaptured") {
    sendResponse({ success: true });
    return false;
  }

  sendResponse({ success: false, error: "Unknown action" });
  return false;
});

// Export for manual / test use
window.clearBeacon = clearBeacon;

// =============================================================================
// DEV TEST — comment out entire block for production
// Flies to the first <button> and draws a box around it after 2s.
// =============================================================================
/*
setTimeout(() => {
  const btn = document.querySelector("button");
  if (!btn) {
    console.warn("[Netra CS] DEV TEST: no button found");
    return;
  }
  const r = btn.getBoundingClientRect();
  const pad = 10;
  void runBeaconSequence({
    text: "Dev test: first button on the page",
    points: [{ type: "selector", selector: "button", label: "First button" }],
    draws: [
      {
        x1: r.left - pad,
        y1: r.top - pad,
        x2: r.right + pad,
        y2: r.bottom + pad,
        color: "#4F46E5",
        label: "This area"
      }
    ]
  });
}, 2000);
*/
