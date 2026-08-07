// DE → EN translator — service worker
// Rate-limited + cached translation, frame broadcast, action badge,
// message validation (F3), privacy-sensitive host checks (F2).

importScripts(
  "shared/protocol.js",
  "shared/markers.js",
  "shared/lang.js",
  "shared/storage-keys.js"
);

const Msg = (self.DeEn && self.DeEn.Msg) || {};
const checkMsg = (self.DeEn && self.DeEn.checkMsg) || (() => true);
const softRedactPII =
  (self.DeEn && self.DeEn.lang && self.DeEn.lang.softRedactPII) || ((t) => t);

const TRANSLATE_ENDPOINT =
  "https://translate.googleapis.com/translate_a/single?client=gtx&sl=de&tl=en&dt=t&q=";

const MAX_ENCODED_Q = 4800;
/** Reject absurd payloads (F3). */
const MAX_PLAIN_CHARS = 20000;
const MAX_BATCH_ITEMS = 100;
const MAX_RETRIES = 0; // fail fast — retries double wall time
const BASE_BACKOFF_MS = 80;

/** Max parallel Google GETs */
const MAX_CONCURRENT_FETCHES = 24;
const MIN_GAP_MS = 0;
const FETCH_TIMEOUT_MS = 4000;

const CACHE_MAX = 12000;
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
  // R5: broader sensitive / private surfaces
  /(^|\.)web\.de$/i,
  /(^|\.)gmx\.(de|net|com)$/i,
  /(^|\.)t-online\.de$/i,
  /(^|\.)posteo\./i,
  /(^|\.)mailfence\.com$/i,
  /(^|\.)fastmail\./i,
  /(^|\.)zoho\.com$/i,
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)myaccount\.google\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)amazon\.(com|de|co\.uk)$/i,
  /(^|\.)ebay\.(com|de)$/i,
  /(^|\.)paypal\.com$/i,
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } catch (err) {
        clearTimeout(timer);
        const aborted = err && (err.name === "AbortError" || /abort/i.test(String(err)));
        if (aborted) {
          lastStatus = 0;
          if (attempt < MAX_RETRIES) continue;
          throw new Error("Translate request timed out");
        }
        if (attempt < MAX_RETRIES) continue;
        throw err;
      }
      clearTimeout(timer);

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
  // Fast-path redaction only when needed
  let raw = text;
  if (typeof raw === "string" && (raw.includes("@") || /\d{6,}/.test(raw))) {
    raw = softRedactPII(raw);
  }
  const s = validateText(raw);
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

/** Parallel batch — all texts race under the shared concurrency pool. */
async function translateBatch(texts) {
  if (!Array.isArray(texts)) throw new Error("Batch must be an array");
  if (texts.length > MAX_BATCH_ITEMS) {
    throw new Error("Batch too large (max " + MAX_BATCH_ITEMS + ")");
  }
  return Promise.all(
    texts.map(async (t) => {
      try {
        return { ok: true, translated: await translateText(t) };
      } catch (err) {
        return {
          ok: false,
          error: String(err && err.message ? err.message : err),
        };
      }
    })
  );
}

async function pingContent(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: Msg.PING || "DE_EN_PING", v: 1 });
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
      target: { tabId, allFrames: false },
      files: ["content.css"],
    });
  } catch {
    /* continue */
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [
        "shared/protocol.js",
        "shared/markers.js",
        "shared/lang.js",
        "shared/storage-keys.js",
        "content.js",
      ],
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

const StorageKeys = (self.DeEn && self.DeEn.StorageKeys) || {
  ENABLED: "deEnEnabled",
};

/** Master power: default ON when key is missing. */
async function isMasterEnabled() {
  try {
    const stored = await chrome.storage.local.get(StorageKeys.ENABLED);
    return stored[StorageKeys.ENABLED] !== false;
  } catch {
    return true;
  }
}

async function setMasterEnabled(on) {
  await chrome.storage.local.set({ [StorageKeys.ENABLED]: !!on });
  applyMasterPowerBadge(!!on);
}

/** Global toolbar badge while soft-off (not tab-scoped). */
function applyMasterPowerBadge(on) {
  try {
    if (!on) {
      chrome.action.setBadgeText({ text: "OFF" });
      chrome.action.setBadgeBackgroundColor({ color: "#5f6368" });
      chrome.action.setTitle({
        title: "DE → EN is off — click this icon to turn it back on",
      });
    } else {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({
        title: "Translate page: German → English (Alt+Shift+B)",
      });
    }
  } catch {
    /* ignore */
  }
}

// Restore OFF badge after SW wake
isMasterEnabled().then((on) => applyMasterPowerBadge(on)).catch(() => {});

function setActionBadge(tabId, { translated, auto, error, sensitive, errorDetail }) {
  try {
    // Don't overwrite global OFF badge while powered down
    chrome.storage.local.get(StorageKeys.ENABLED, (stored) => {
      try {
        if (stored && stored[StorageKeys.ENABLED] === false) {
          chrome.action.setBadgeText({ text: "OFF" });
          chrome.action.setBadgeBackgroundColor({ color: "#5f6368" });
          chrome.action.setTitle({
            title: "DE → EN is off — click this icon to turn it back on",
          });
          return;
        }
        if (error) {
          chrome.action.setBadgeText({ tabId, text: "!" });
          chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
          chrome.action.setTitle({
            tabId,
            title: "DE → EN: " + (errorDetail || "translation error"),
          });
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
            title: "Translate page: German → English (Alt+Shift+B)",
          });
        }
      } catch {
        /* tab gone */
      }
    });
  } catch {
    /* tab gone */
  }
}

/** I6: surface toolbar failures instead of silent no-op */
async function reportToolbarFailure(tabId, reason) {
  try {
    chrome.action.setBadgeText({ tabId, text: "×" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#5f6368" });
    chrome.action.setTitle({ tabId, title: "DE → EN: " + reason });
  } catch {
    /* ignore */
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: Msg.TOOLBAR_FAIL || "DE_EN_TOOLBAR_FAIL",
      v: 1,
      reason,
    });
  } catch {
    /* no content script — badge title is enough */
  }
}

/** Top frame only — iframe fan-out multiplies rate limits and main-thread work. */
async function broadcastToggle(tabId) {
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: Msg.TOGGLE || "DE_EN_TOGGLE", v: 1 },
      { frameId: 0 }
    );
  } catch {
    /* no content script */
  }
}

async function broadcastPowerOn(tabId) {
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: Msg.POWER_ON || "DE_EN_POWER_ON", v: 1 },
      { frameId: 0 }
    );
  } catch {
    /* ignore */
  }
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: Msg.SHOW_PANEL || "DE_EN_SHOW_PANEL", v: 1 },
      { frameId: 0 }
    );
  } catch {
    /* ignore */
  }
}

async function toggleActiveTab(tab) {
  if (!tab || !tab.id) return;

  const url = tab.url || "";
  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com")
  ) {
    await reportToolbarFailure(
      tab.id,
      "Cannot run on this page (browser-restricted URL)"
    );
    return;
  }

  // Soft-off: toolbar icon turns the extension back on (no chrome://extensions)
  if (!(await isMasterEnabled())) {
    await setMasterEnabled(true);
    const ok = await ensureContentScript(tab.id);
    if (!ok) {
      await reportToolbarFailure(
        tab.id,
        "Turned on — refresh this page to show the panel"
      );
      return;
    }
    await broadcastPowerOn(tab.id);
    return;
  }

  const ok = await ensureContentScript(tab.id);
  if (!ok) {
    await reportToolbarFailure(
      tab.id,
      "Could not inject into this tab — try refreshing the page"
    );
    return;
  }
  await broadcastToggle(tab.id);
}

chrome.action.onClicked.addListener((tab) => {
  toggleActiveTab(tab);
});

// Manifest command Alt+Shift+B
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "toggle-translate") return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Shortcut also re-enables when soft-off
    await toggleActiveTab(tab);
  });
}

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
  // N: protocol version gate
  if (!checkMsg(msg)) {
    sendResponse({ ok: false, error: "protocol version mismatch" });
    return false;
  }

  const t = msg.type;

  if (t === (Msg.TRANSLATE || "DE_EN_TRANSLATE")) {
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

  if (t === (Msg.TRANSLATE_BATCH || "DE_EN_TRANSLATE_BATCH")) {
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

  if (t === (Msg.BROADCAST_TOGGLE || "DE_EN_BROADCAST_TOGGLE")) {
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

  if (t === (Msg.CHECK_SENSITIVE || "DE_EN_CHECK_SENSITIVE")) {
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

  if (t === (Msg.ACTION_STATE || "DE_EN_ACTION_STATE")) {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      setActionBadge(tabId, {
        translated: !!msg.translated,
        auto: !!msg.auto,
        error: !!msg.error,
        sensitive: !!msg.sensitive,
        errorDetail: msg.errorDetail || "",
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  // Soft power-off — stays installed; toolbar icon turns it back on
  if (
    t === (Msg.POWER_OFF || "DE_EN_POWER_OFF") ||
    t === "DE_EN_DISABLE_SELF"
  ) {
    setMasterEnabled(false)
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: String(err && err.message ? err.message : err),
        })
      );
    return true;
  }

  if (t === (Msg.POWER_ON || "DE_EN_POWER_ON")) {
    setMasterEnabled(true)
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: String(err && err.message ? err.message : err),
        })
      );
    return true;
  }

  return false;
});
