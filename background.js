// DE → EN translator — service worker
// Rate-limited + cached translation, frame broadcast, action badge,
// message validation (F3), privacy-sensitive host checks (F2).

const TRANSLATE_ENDPOINT =
  "https://translate.googleapis.com/translate_a/single?client=gtx&sl=de&tl=en&dt=t&q=";

const MAX_ENCODED_Q = 3500;
/** Reject absurd payloads (F3). */
const MAX_PLAIN_CHARS = 12000;
const MAX_BATCH_ITEMS = 40;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 450;

const MAX_CONCURRENT_FETCHES = 2;
const MIN_GAP_MS = 120;

const CACHE_MAX = 800;
const translateCache = new Map();

let activeFetches = 0;
let lastFetchAt = 0;
const waitQueue = [];

// Sensitive hosts — auto-translate blocked; manual still allowed with warning path in content (F1/F2).
const SENSITIVE_HOST_RES = [
  /(^|\.)gmail\.com$/i,
  /(^|\.)mail\.google\.com$/i,
  /(^|\.)outlook\.(com|office\.com|live\.com)$/i,
  /(^|\.)office\.com$/i,
  /(^|\.)microsoftonline\.com$/i,
  /(^|\.)yahoo\.com$/i,
  /(^|\.)proton\.me$/i,
  /(^|\.)protonmail\.com$/i,
  /(^|\.)icloud\.com$/i,
  /(^|\.)bank/i,
  /(^|\.)paypal\./i,
  /(^|\.)stripe\./i,
  /(^|\.)chase\.com$/i,
  /(^|\.)wellsfargo\.com$/i,
  /(^|\.)local$/i,
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/,
];

function isSensitiveHost(host) {
  if (!host) return false;
  return SENSITIVE_HOST_RES.some((re) => re.test(host));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cacheGet(text) {
  if (!translateCache.has(text)) return null;
  const v = translateCache.get(text);
  translateCache.delete(text);
  translateCache.set(text, v);
  return v;
}

function cacheSet(text, translated) {
  if (translateCache.has(text)) translateCache.delete(text);
  translateCache.set(text, translated);
  while (translateCache.size > CACHE_MAX) {
    const oldest = translateCache.keys().next().value;
    translateCache.delete(oldest);
  }
}

function acquireSlot() {
  return new Promise((resolve) => {
    waitQueue.push(resolve);
    pumpQueue();
  });
}

function pumpQueue() {
  while (activeFetches < MAX_CONCURRENT_FETCHES && waitQueue.length) {
    activeFetches++;
    waitQueue.shift()();
  }
}

function releaseSlot() {
  activeFetches = Math.max(0, activeFetches - 1);
  pumpQueue();
}

async function rateLimitedFetch(url) {
  let lastStatus = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.random() * 200);
    }

    await acquireSlot();
    try {
      const gap = MIN_GAP_MS - (Date.now() - lastFetchAt);
      if (gap > 0) await sleep(gap);
      lastFetchAt = Date.now();

      let res;
      try {
        res = await fetch(url);
      } catch (err) {
        if (attempt < MAX_RETRIES) continue;
        throw err;
      }

      lastStatus = res.status;
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        if (attempt < MAX_RETRIES) continue;
      }
      return res;
    } finally {
      releaseSlot();
    }
  }

  throw new Error("Translate request failed after retries: " + lastStatus);
}

function validateText(text) {
  if (text == null) return "";
  const s = String(text);
  if (s.length > MAX_PLAIN_CHARS) {
    throw new Error("Text exceeds max length (" + MAX_PLAIN_CHARS + ")");
  }
  return s;
}

async function translateText(text) {
  const s = validateText(text);
  if (!s.trim()) return s;

  const cached = cacheGet(s);
  if (cached != null) return cached;

  const encoded = encodeURIComponent(s);
  if (encoded.length > MAX_ENCODED_Q) {
    throw new Error("Chunk too large for GET URL");
  }

  const url = TRANSLATE_ENDPOINT + encoded;
  const res = await rateLimitedFetch(url);

  if (!res.ok) {
    throw new Error("Translate request failed: " + res.status);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Invalid translate response");
  }

  // Basic shape check (F4)
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("Unexpected translate response shape");
  }

  const parts = data[0] || [];
  const translated = parts
    .map((seg) => (Array.isArray(seg) ? seg[0] || "" : ""))
    .join("");

  // Reject obviously broken payloads
  if (typeof translated !== "string") {
    throw new Error("Invalid translation payload");
  }

  cacheSet(s, translated);
  return translated;
}

async function translateBatch(texts) {
  if (!Array.isArray(texts)) throw new Error("Batch must be an array");
  if (texts.length > MAX_BATCH_ITEMS) {
    throw new Error("Batch too large (max " + MAX_BATCH_ITEMS + ")");
  }
  const out = [];
  for (const t of texts) {
    try {
      out.push({ ok: true, translated: await translateText(t) });
    } catch (err) {
      out.push({
        ok: false,
        error: String(err && err.message ? err.message : err),
      });
    }
  }
  return out;
}

async function pingContent(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "DE_EN_PING" });
}

async function ensureContentScript(tabId) {
  try {
    await pingContent(tabId);
    return true;
  } catch {
    // not present
  }

  try {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ["content.css"],
    });
  } catch {
    /* continue */
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
  } catch {
    return false;
  }

  for (let i = 0; i < 12; i++) {
    try {
      await pingContent(tabId);
      return true;
    } catch {
      await sleep(40);
    }
  }
  return false;
}

function setActionBadge(tabId, { translated, auto, error, sensitive }) {
  try {
    if (error) {
      chrome.action.setBadgeText({ tabId, text: "!" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
      chrome.action.setTitle({ tabId, title: "DE → EN: translation error" });
      return;
    }
    if (translated) {
      chrome.action.setBadgeText({ tabId, text: "EN" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#0a6cff" });
      chrome.action.setTitle({
        tabId,
        title: "DE → EN: showing English (click to restore German)",
      });
    } else if (sensitive) {
      chrome.action.setBadgeText({ tabId, text: "P" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#f9ab00" });
      chrome.action.setTitle({
        tabId,
        title: "DE → EN: sensitive site — auto-translate disabled",
      });
    } else if (auto) {
      chrome.action.setBadgeText({ tabId, text: "A" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#34c759" });
      chrome.action.setTitle({ tabId, title: "DE → EN: auto-translate ON" });
    } else {
      chrome.action.setBadgeText({ tabId, text: "" });
      chrome.action.setTitle({
        tabId,
        title: "Translate page: German → English",
      });
    }
  } catch {
    /* tab gone */
  }
}

async function broadcastToggle(tabId) {
  let frameIds = [0];
  try {
    if (chrome.webNavigation && chrome.webNavigation.getAllFrames) {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      if (frames && frames.length) frameIds = frames.map((f) => f.frameId);
    }
  } catch {
    /* main frame only */
  }

  await Promise.all(
    frameIds.map((frameId) =>
      chrome.tabs
        .sendMessage(tabId, { type: "DE_EN_TOGGLE" }, { frameId })
        .catch(() => {})
    )
  );
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  const ok = await ensureContentScript(tab.id);
  if (!ok) return;
  await broadcastToggle(tab.id);
});

/** Only accept messages from our own extension content scripts (F3). */
function isTrustedSender(sender) {
  if (!sender) return false;
  // Content scripts have a tab; extension pages have url chrome-extension://
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (!isTrustedSender(sender)) {
    sendResponse({ ok: false, error: "untrusted sender" });
    return false;
  }

  if (msg.type === "DE_EN_TRANSLATE") {
    translateText(msg.text)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: String(err && err.message ? err.message : err),
        })
      );
    return true;
  }

  if (msg.type === "DE_EN_TRANSLATE_BATCH") {
    const texts = Array.isArray(msg.texts) ? msg.texts : [];
    translateBatch(texts)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: String(err && err.message ? err.message : err),
        })
      );
    return true;
  }

  if (msg.type === "DE_EN_BROADCAST_TOGGLE") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return false;
    }
    broadcastToggle(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "DE_EN_CHECK_SENSITIVE") {
    const host = (msg.host || (sender.tab && sender.tab.url) || "").toString();
    let hostname = host;
    try {
      if (host.includes("://")) hostname = new URL(host).hostname;
    } catch {
      /* use as-is */
    }
    sendResponse({ ok: true, sensitive: isSensitiveHost(hostname) });
    return false;
  }

  if (msg.type === "DE_EN_ACTION_STATE") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      setActionBadge(tabId, {
        translated: !!msg.translated,
        auto: !!msg.auto,
        error: !!msg.error,
        sensitive: !!msg.sensitive,
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
