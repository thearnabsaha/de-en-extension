// DE → EN Page Translator — content script (v1.4)
// A–I: state machine, rate-limit SW, SPA observer, per-site prefs, privacy,
// closed-shadow UI, performance, language confidence, drag/theme/progress.

(() => {
  if (typeof window.__deEnCleanup === "function") {
    try { window.__deEnCleanup(); } catch { /* ignore */ }
  }

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CODE", "PRE",
    "TEXTAREA", "INPUT", "IFRAME", "CANVAS", "SELECT", "OPTION",
    "KBD", "SAMP", "MATH", "TEMPLATE", "OBJECT", "EMBED",
  ]);
  const ATTRS_TO_TRANSLATE = [
    "title", "alt", "aria-label", "placeholder", "aria-description",
  ];
  // G3: compile once; reset lastIndex before each use
  const MARKER_RE = /\u2060⟦DEEN:(\d+)⟧\u2060/g;
  const MARKER = (i) => `\u2060⟦DEEN:${i}⟧\u2060`;
  const MAX_PACK_CHARS = 1800;
  const MAX_ENCODED_HINT = 3400;
  const CONCURRENCY = 3;
  const MIN_RETRANSLATE_GAP_MS = 1600;
  const OBSERVER_DEBOUNCE_MS = 700;
  /** G1: yield to main thread every N nodes while walking */
  const WALK_YIELD_EVERY = 350;
  /** G4: hard cap tracked nodes to limit memory */
  const MAX_TRACKED_NODES = 8000;
  const MAX_HASH_SET = 12000;

  const DEFAULT_HIDDEN_HOSTS = [
    "chrome.google.com",
    "chromewebstore.google.com",
  ];
  const SENSITIVE_HOST_RES = [
    /(^|\.)gmail\.com$/i, /(^|\.)mail\.google\.com$/i,
    /(^|\.)outlook\.(com|office\.com|live\.com)$/i,
    /(^|\.)office\.com$/i, /(^|\.)microsoftonline\.com$/i,
    /(^|\.)yahoo\.com$/i, /(^|\.)proton\.me$/i, /(^|\.)protonmail\.com$/i,
    /(^|\.)icloud\.com$/i, /(^|\.)bank/i, /(^|\.)paypal\./i, /(^|\.)stripe\./i,
    /(^|\.)local$/i, /^localhost$/i, /^127\.\d+\.\d+\.\d+$/,
    /^10\.\d+\.\d+\.\d+$/, /^192\.168\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/,
  ];

  const DE_WORDS = /\b(der|die|das|und|ist|nicht|mit|für|auf|ein|eine|einen|einem|einer|ich|wir|sie|den|dem|des|von|zu|im|am|als|auch|oder|aber|wird|sind|hat|haben|kann|nach|bei|aus|über|wenn|nur|noch|schon|mehr|sehr|alle|diese|dieser|werden|bitte|danke|uhr|heute|morgen|hier|dort|jetzt|dann|weil|dass|daß|kein|keine|durch|gegen|ohne|unter|zwischen|während|seit|sowie|jedoch|bereits|wieder|immer|etwas|nichts|jemand|warum|wieso|welche|welcher|welches|ihre|ihren|seinem|seiner|unsere|können|müssen|sollen|wollen|machen|gehen|kommen|sehen|geben|nehmen|finden|stehen|liegen|bleiben|scheinen|heißt|grüß|tschüss|willkommen|anmeldung|abmelden|speichern|löschen|suchen|einstellungen|datenschutz|impressum|agb|weiter|zurück|schließen|öffnen|hilfe|konto|passwort)\b/gi;
  const EN_WORDS = /\b(the|and|is|are|was|were|for|with|this|that|from|your|have|has|will|not|you|our|can|all|about|more|been|their|which|would|there|what|when|who|how|also|into|than|then|only|other|some|such|these|those|please|click|login|logout|search|home|settings|privacy|cookie|accept|continue|cancel|submit|download|upload|account|password|welcome|hello|thanks|help|close|open|next|back|save|delete|edit|view|share|follow)\b/gi;

  const IS_TOP = window === window.top;

  let runGeneration = 0;
  let phase = "idle";
  const originalTextByNode = new Map();
  const originalAttrsByEl = new Map();
  const seenSourceHashes = new Set();
  const outputHashes = new Set();

  let translated = false;
  let autoMode = false;
  let globalAutoMode = false;
  let siteAutoOverride = null;
  /** H3: null | 'de' | 'en' */
  let siteLangOverride = null;
  let panelMinimized = false;
  let hiddenOnSite = false;
  let lastError = false;
  let lastErrorDetail = "";
  let privacyAccepted = false;
  let sensitiveSite = false;
  /** I10: 'auto' | 'dark' | 'light' */
  let themeMode = "auto";
  /** I1: { top, right } or null */
  let panelPos = null;

  let applyingMutations = false;
  let lastRetranslateAt = 0;
  let retranslateTimer = null;
  let observer = null;
  let mutateTimer = null;
  /** G2/H: cached language detection */
  let langDetectCache = null;

  let hostEl = null;
  let shadowRoot = null;
  let panelEl = null;
  let fabEl = null;
  let autoSwitchEl = null;
  let siteAutoSwitchEl = null;
  let minBtnEl = null;
  let hideBtnEl = null;
  let unhideBtnEl = null;
  let privacyEl = null;
  let progressEl = null;
  let statusLineEl = null;
  let langSelectEl = null;
  let themeSelectEl = null;
  let dragHandleEl = null;

  function hostname() {
    try { return location.hostname || ""; } catch { return ""; }
  }
  function isSensitiveHost(host) {
    if (!host) return false;
    return SENSITIVE_HOST_RES.some((re) => re.test(host));
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }
  function capSet(set, max) {
    while (set.size > max) {
      const first = set.values().next().value;
      set.delete(first);
    }
  }
  function nextAncestor(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode && el.getRootNode();
    if (root && root.host) return root.host;
    return null;
  }
  function isVisible(el) {
    if (!el || !(el instanceof Element)) return true;
    let e = el;
    while (e) {
      if (e.nodeType === 1) {
        if (e.hasAttribute("hidden")) return false;
        if (e.getAttribute("aria-hidden") === "true") return false;
        if (e.getAttribute("data-no-translate") != null) return false;
        if (e.id === "__de_en_host") return false;
        let style;
        try { style = window.getComputedStyle(e); } catch { style = null; }
        if (style) {
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (parseFloat(style.opacity || "1") === 0) return false;
        }
      }
      e = nextAncestor(e);
    }
    return true;
  }
  function shouldSkipElement(el) {
    if (!el || !(el instanceof Element)) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.id === "__de_en_host") return true;
    if (el.closest && el.closest("[contenteditable=''], [contenteditable='true']")) return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest("[data-no-translate], .notranslate, #__de_en_host")) return true;
    return false;
  }

  function countMatches(re, text) {
    re.lastIndex = 0;
    const m = text.match(re);
    return m ? m.length : 0;
  }

  /** H: confidence-scored detection */
  function scoreGermanText(text) {
    if (!text || text.length < 8) {
      return { isGerman: false, confidence: 0, deHits: 0, enHits: 0, umlauts: 0 };
    }
    const deHits = countMatches(DE_WORDS, text);
    const enHits = countMatches(EN_WORDS, text);
    const umlauts = (text.match(/[äöüÄÖÜß]/g) || []).length;
    // compound-ish long tokens common in DE
    const longCompounds = (text.match(/\b[A-ZÄÖÜ][a-zäöüß]{10,}\b/g) || []).length;

    let score = 0;
    score += Math.min(deHits, 20) * 0.04;
    score += Math.min(umlauts, 12) * 0.05;
    score += Math.min(longCompounds, 6) * 0.03;
    score -= Math.min(enHits, 20) * 0.035;
    score = Math.max(0, Math.min(1, score));

    // strong signals
    if (umlauts >= 3 && deHits >= 2) score = Math.max(score, 0.72);
    if (deHits >= 6 && deHits > enHits) score = Math.max(score, 0.65);
    if (enHits >= 8 && enHits > deHits * 2 && umlauts === 0) score = Math.min(score, 0.25);

    const isGerman = score >= 0.42 && (deHits + umlauts) >= 2;
    return { isGerman, confidence: score, deHits, enHits, umlauts };
  }

  function looksMostlyEnglish(text) {
    const s = scoreGermanText(text);
    return s.enHits >= 3 && s.enHits > s.deHits * 2 && s.umlauts === 0;
  }
  function looksGermanSample(text) {
    return scoreGermanText(text).isGerman;
  }
  function looksLikeUrlOrCode(text) {
    const t = text.trim();
    if (/^https?:\/\//i.test(t)) return true;
    if (/^[\w.+-]+@[\w.-]+\.\w{2,}$/.test(t)) return true;
    if (/^[\w.-]+\.[a-z]{2,}(\/[\w./?&=%+-]*)?$/i.test(t) && !/\s/.test(t)) return true;
    if (/^[{[][\s\S]*[}\]]$/.test(t) && t.length < 500) return true;
    if (/^[a-f0-9]{8,}(-[a-f0-9]{4,})+$/i.test(t)) return true;
    return false;
  }
  function shouldTranslateText(text) {
    if (!text || !String(text).trim()) return false;
    if (looksLikeUrlOrCode(text)) return false;
    if (/^[\d\s.,:;+%\-–—/\\|()[\]{}$€£¥]+$/.test(text.trim())) return false;
    const h = hashStr(text);
    if (seenSourceHashes.has(h) || outputHashes.has(h)) return false;
    if (looksMostlyEnglish(text) && !looksGermanSample(text)) return false;
    return true;
  }

  /** G2: sample limited text nodes only; H1/H2: confidence + override */
  function detectPageLanguage(forceRefresh) {
    if (langDetectCache && !forceRefresh) return langDetectCache;

    // H3 site override
    if (siteLangOverride === "de") {
      langDetectCache = { isGerman: true, confidence: 1, reason: "site-override-de", autoOk: true };
      return langDetectCache;
    }
    if (siteLangOverride === "en") {
      langDetectCache = { isGerman: false, confidence: 1, reason: "site-override-en", autoOk: false };
      return langDetectCache;
    }

    const lang = (
      document.documentElement.lang ||
      document.documentElement.getAttribute("xml:lang") || ""
    ).toLowerCase().trim();

    let sample = "";
    let nodeCount = 0;
    try {
      const root = document.body || document.documentElement;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          if (!p || shouldSkipElement(p)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let n;
      while ((n = walker.nextNode()) && sample.length < 2500 && nodeCount < 120) {
        sample += n.nodeValue + " ";
        nodeCount++;
      }
    } catch {
      sample = "";
    }

    const scored = scoreGermanText(sample);
    let isGerman = scored.isGerman;
    let confidence = scored.confidence;
    let reason = "sample";

    if (lang.startsWith("de")) {
      isGerman = true;
      confidence = Math.max(confidence, 0.9);
      reason = "html-lang-de";
    } else if (lang && lang.length >= 2 && !lang.startsWith("de")) {
      // H2: explicit non-DE lang requires stronger sample evidence
      if (confidence < 0.62) {
        isGerman = false;
        reason = "html-lang-non-de";
      } else {
        reason = "sample-overrides-lang";
      }
    }

    const meta = document.querySelector(
      'meta[http-equiv="content-language"], meta[name="language"]'
    );
    if (meta) {
      const c = (meta.getAttribute("content") || "").toLowerCase();
      if (c.startsWith("de")) {
        isGerman = true;
        confidence = Math.max(confidence, 0.85);
        reason = "meta-lang-de";
      }
    }

    // Auto only when reasonably confident (H1/H2)
    const autoOk = isGerman && confidence >= 0.5;
    langDetectCache = { isGerman, confidence, reason, autoOk, ...scored };
    return langDetectCache;
  }

  function pageLooksGerman() {
    return detectPageLanguage().isGerman;
  }

  function encodedLen(s) {
    try { return encodeURIComponent(s).length; } catch { return s.length * 3; }
  }

  function computeEffectiveAuto() {
    if (sensitiveSite) return false;
    if (siteAutoOverride === true) return true;
    if (siteAutoOverride === false) return false;
    return globalAutoMode;
  }

  // ---------- storage ----------
  async function loadPrefs() {
    const host = hostname();
    sensitiveSite = isSensitiveHost(host);
    try {
      const stored = await chrome.storage.local.get([
        "deEnAutoMode", "deEnSitePrefs", "deEnHiddenHosts",
        "deEnPrivacyAccepted", "deEnTheme",
      ]);
      globalAutoMode = !!stored.deEnAutoMode;
      privacyAccepted = !!stored.deEnPrivacyAccepted;
      themeMode = stored.deEnTheme === "light" || stored.deEnTheme === "dark"
        ? stored.deEnTheme : "auto";

      const sitePrefs = stored.deEnSitePrefs && typeof stored.deEnSitePrefs === "object"
        ? stored.deEnSitePrefs : {};
      const site = sitePrefs[host] || {};
      panelMinimized = site.minimized != null ? !!site.minimized : false;
      siteAutoOverride = site.auto === true ? true : site.auto === false ? false : null;
      siteLangOverride = site.lang === "de" || site.lang === "en" ? site.lang : null;
      panelPos = site.pos && typeof site.pos.top === "number" ? site.pos : null;

      const userHidden = Array.isArray(stored.deEnHiddenHosts) ? stored.deEnHiddenHosts : [];
      const hiddenSet = new Set([...DEFAULT_HIDDEN_HOSTS, ...userHidden]);
      hiddenOnSite = !!site.hidden || hiddenSet.has(host);
      autoMode = computeEffectiveAuto();
      langDetectCache = null;
    } catch {
      globalAutoMode = false;
      autoMode = false;
      panelMinimized = false;
      hiddenOnSite = DEFAULT_HIDDEN_HOSTS.includes(host);
      privacyAccepted = false;
      siteAutoOverride = null;
      siteLangOverride = null;
      themeMode = "auto";
      panelPos = null;
      sensitiveSite = isSensitiveHost(host);
    }
  }

  async function patchSitePrefs(patch) {
    const host = hostname();
    if (!host) return;
    let sitePrefs = {};
    try {
      const stored = await chrome.storage.local.get("deEnSitePrefs");
      sitePrefs = stored.deEnSitePrefs && typeof stored.deEnSitePrefs === "object"
        ? { ...stored.deEnSitePrefs } : {};
    } catch { sitePrefs = {}; }
    sitePrefs[host] = { ...(sitePrefs[host] || {}), ...patch };
    await chrome.storage.local.set({ deEnSitePrefs: sitePrefs });
  }

  async function setHiddenOnThisSite(hide) {
    const host = hostname();
    if (!host) return;
    hiddenOnSite = hide;
    await patchSitePrefs({ hidden: hide });
    try {
      const stored = await chrome.storage.local.get("deEnHiddenHosts");
      let list = Array.isArray(stored.deEnHiddenHosts) ? stored.deEnHiddenHosts.slice() : [];
      if (hide) { if (!list.includes(host)) list.push(host); }
      else list = list.filter((h) => h !== host);
      await chrome.storage.local.set({ deEnHiddenHosts: list });
    } catch { /* ignore */ }
  }
  async function setMinimized(min) {
    panelMinimized = min;
    await patchSitePrefs({ minimized: min });
  }
  async function setSiteAutoOverride(value) {
    siteAutoOverride = value;
    await patchSitePrefs({ auto: value });
    autoMode = computeEffectiveAuto();
  }
  async function setSiteLangOverride(value) {
    siteLangOverride = value;
    await patchSitePrefs({ lang: value });
    langDetectCache = null;
  }
  async function setGlobalAuto(on) {
    globalAutoMode = on;
    await chrome.storage.local.set({ deEnAutoMode: on });
    autoMode = computeEffectiveAuto();
  }
  async function setTheme(mode) {
    themeMode = mode;
    await chrome.storage.local.set({ deEnTheme: mode });
    applyTheme();
  }
  async function savePanelPos(pos) {
    panelPos = pos;
    await patchSitePrefs({ pos });
  }

  function pushActionState(extra = {}) {
    if (!IS_TOP) return;
    try {
      chrome.runtime.sendMessage({
        type: "DE_EN_ACTION_STATE",
        translated, auto: autoMode, error: lastError,
        sensitive: sensitiveSite, errorDetail: lastErrorDetail, ...extra,
      });
    } catch { /* ignore */ }
  }

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    const host = hostname();
    let need = false;
    if (changes.deEnAutoMode) {
      globalAutoMode = !!changes.deEnAutoMode.newValue;
      autoMode = computeEffectiveAuto();
      need = true;
    }
    if (changes.deEnPrivacyAccepted) {
      privacyAccepted = !!changes.deEnPrivacyAccepted.newValue;
      need = true;
    }
    if (changes.deEnTheme) {
      themeMode = changes.deEnTheme.newValue || "auto";
      applyTheme();
      need = true;
    }
    if (changes.deEnSitePrefs) {
      const site = (changes.deEnSitePrefs.newValue || {})[host] || {};
      if (site.minimized != null) panelMinimized = !!site.minimized;
      if (site.hidden != null) hiddenOnSite = !!site.hidden;
      siteAutoOverride = site.auto === true ? true : site.auto === false ? false : null;
      siteLangOverride = site.lang === "de" || site.lang === "en" ? site.lang : null;
      if (site.pos) panelPos = site.pos;
      autoMode = computeEffectiveAuto();
      langDetectCache = null;
      need = true;
    }
    if (changes.deEnHiddenHosts) {
      loadPrefs().then(() => { syncPanelControls(); applyPanelVisibility(); applyPanelPosition(); pushActionState(); });
      return;
    }
    if (need) {
      syncPanelControls();
      applyPanelVisibility();
      applyPanelPosition();
      pushActionState();
    }
  }
  try { chrome.storage.onChanged.addListener(onStorageChanged); } catch { /* ignore */ }

  // ---------- DOM walk (G1: yield) ----------
  function walkComposedTreeSync(root, onText, onElement, budget) {
    // budget = { count, limit, stop:false }
    if (!root || (budget && budget.stop)) return;
    const visit = (node) => {
      if (!node || (budget && budget.stop)) return;
      if (budget) {
        budget.count++;
        if (budget.count >= budget.limit) {
          budget.stop = true;
          budget.resumeNode = node;
          return;
        }
      }
      if (node.nodeType === Node.TEXT_NODE) {
        onText(node);
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        if (onElement) onElement(el);
        if (shouldSkipElement(el)) return;
        if (el.shadowRoot) visit(el.shadowRoot);
        const children = el.childNodes;
        for (let i = 0; i < children.length; i++) visit(children[i]);
        return;
      }
      if (node.childNodes) {
        const children = node.childNodes;
        for (let i = 0; i < children.length; i++) visit(children[i]);
      }
    };
    visit(root);
  }

  /** Iterative DFS with yields (G1) */
  async function collectWorkAsync(root, gen) {
    const textNodes = [];
    const attrTargets = [];
    const seenEl = new Set();
    const stack = [root];
    let steps = 0;

    while (stack.length) {
      if (gen !== runGeneration) return { textNodes, attrTargets };
      const node = stack.pop();
      if (!node) continue;
      steps++;
      if (steps % WALK_YIELD_EVERY === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (!text || !text.trim()) continue;
        const parent = node.parentElement;
        if (!parent || shouldSkipElement(parent)) continue;
        let p = parent;
        let skip = false;
        while (p) {
          if (p.nodeType === 1 && (SKIP_TAGS.has(p.tagName) || shouldSkipElement(p))) {
            skip = true; break;
          }
          p = nextAncestor(p);
        }
        if (skip) continue;
        if (!isVisible(parent)) continue;
        if (originalTextByNode.has(node)) continue;
        if (!shouldTranslateText(text)) continue;
        textNodes.push(node);
        continue;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        if (!seenEl.has(el)) {
          seenEl.add(el);
          if (!shouldSkipElement(el) && (isVisible(el) || el.tagName === "IMG")) {
            const existing = originalAttrsByEl.get(el) || {};
            const pending = {};
            for (const attr of ATTRS_TO_TRANSLATE) {
              if (existing[attr] != null) continue;
              const val = el.getAttribute(attr);
              if (!val || !val.trim()) continue;
              if (!shouldTranslateText(val)) continue;
              pending[attr] = val;
            }
            if (Object.keys(pending).length) attrTargets.push({ el, attrs: pending });
          }
        }
        if (shouldSkipElement(el)) continue;
        if (el.shadowRoot) stack.push(el.shadowRoot);
        const children = el.childNodes;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
        continue;
      }
      if (node.childNodes) {
        const children = node.childNodes;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      }
    }
    return { textNodes, attrTargets };
  }

  function buildWorkItems(textNodes, attrTargets) {
    const items = [];
    for (const node of textNodes) {
      items.push({ kind: "text", node, value: node.nodeValue, fullOriginal: node.nodeValue });
    }
    for (const { el, attrs } of attrTargets) {
      for (const [attr, value] of Object.entries(attrs)) {
        items.push({ kind: "attr", el, attr, value, fullOriginal: value });
      }
    }
    return items;
  }

  function packChunk(items) {
    return items.map((it, i) => it.value + (i < items.length - 1 ? MARKER(i) : "")).join("");
  }

  function splitOnBoundaries(text, maxChars) {
    if (text.length <= maxChars && encodedLen(text) <= MAX_ENCODED_HINT) return [text];
    const parts = [];
    let rest = text;
    while (rest.length) {
      if (rest.length <= maxChars && encodedLen(rest) <= MAX_ENCODED_HINT) {
        parts.push(rest); break;
      }
      let end = Math.min(maxChars, rest.length);
      while (end > 200 && encodedLen(rest.slice(0, end)) > MAX_ENCODED_HINT) {
        end = Math.floor(end * 0.75);
      }
      const window = rest.slice(0, end);
      const minBreak = Math.floor(window.length * 0.35);
      const seps = [". ", "? ", "! ", ".\n", "?\n", "!\n", "\n", "; ", ", ", " "];
      let breakAt = -1;
      for (const sep of seps) {
        const idx = window.lastIndexOf(sep);
        if (idx >= minBreak) { breakAt = idx + sep.length; break; }
      }
      if (breakAt <= 0) breakAt = window.length;
      parts.push(rest.slice(0, breakAt));
      rest = rest.slice(breakAt);
    }
    return parts.filter((p) => p.length);
  }

  function chunkItems(items) {
    const chunks = [];
    let current = [];
    const flush = () => { if (current.length) { chunks.push(current); current = []; } };
    for (const item of items) {
      const piece = item.value;
      if (item.kind === "text" && (encodedLen(piece) > MAX_ENCODED_HINT || piece.length > MAX_PACK_CHARS)) {
        flush(); chunks.push([{ ...item, _isLargeText: true }]); continue;
      }
      if (item.kind === "attr" && (encodedLen(piece) > MAX_ENCODED_HINT || piece.length > MAX_PACK_CHARS)) {
        flush(); chunks.push([{ ...item, _isLargeAttr: true }]); continue;
      }
      const trial = current.concat([item]);
      const packed = packChunk(trial);
      if (current.length && (packed.length > MAX_PACK_CHARS || encodedLen(packed) > MAX_ENCODED_HINT)) flush();
      current.push(item);
    }
    flush();
    return chunks;
  }

  function unpackChunk(translatedFull, count) {
    if (count === 1) return [translatedFull == null ? "" : translatedFull];
    MARKER_RE.lastIndex = 0;
    const parts = [];
    let last = 0;
    let m;
    const src = translatedFull || "";
    while ((m = MARKER_RE.exec(src)) !== null) {
      parts.push(src.slice(last, m.index));
      last = m.index + m[0].length;
    }
    parts.push(src.slice(last));
    if (parts.length !== count) {
      throw new Error("Marker remap failed: expected " + count + " parts, got " + parts.length);
    }
    return parts;
  }

  // ---------- network ----------
  function friendlyError(err) {
    const msg = String(err && err.message ? err.message : err || "");
    if (/429|403|rate/i.test(msg)) return "Rate limited — wait and retry";
    if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Network error — check connection";
    if (/Extension context invalidated/i.test(msg)) return "Extension reloaded — refresh the page";
    if (/too large|max length/i.test(msg)) return "Text chunk too large";
    if (/Marker remap/i.test(msg)) return "Translation mapping failed";
    if (msg) return msg.slice(0, 80);
    return "Translation failed";
  }

  function translateViaBackground(text) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "DE_EN_TRANSLATE", text }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res || !res.ok) reject(new Error((res && res.error) || "Translation failed"));
          else resolve(res.translated);
        });
      } catch (e) { reject(e); }
    });
  }

  function translateBatchViaBackground(texts) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "DE_EN_TRANSLATE_BATCH", texts }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res || !res.ok) reject(new Error((res && res.error) || "Batch failed"));
          else resolve(res.results || []);
        });
      } catch (e) { reject(e); }
    });
  }

  async function mapPool(items, limit, fn, gen) {
    const results = new Array(items.length);
    let next = 0, active = 0, failed = 0;
    return new Promise((resolve) => {
      const kick = () => {
        if (gen !== runGeneration && active === 0) { resolve({ results, failed }); return; }
        while (active < limit && next < items.length && gen === runGeneration) {
          const i = next++;
          active++;
          Promise.resolve(fn(items[i], i))
            .then((r) => { results[i] = r; })
            .catch(() => { failed++; results[i] = null; })
            .finally(() => {
              active--;
              if ((next >= items.length || gen !== runGeneration) && active === 0) resolve({ results, failed });
              else kick();
            });
        }
        if (items.length === 0) resolve({ results, failed });
      };
      kick();
    });
  }

  function isGenCurrent(gen) { return gen === runGeneration; }

  function withOwnMutation(fn) {
    applyingMutations = true;
    try { return fn(); }
    finally { queueMicrotask(() => { applyingMutations = false; }); }
  }

  function trackOriginal(node, source) {
    if (originalTextByNode.size >= MAX_TRACKED_NODES) pruneDisconnected();
    if (originalTextByNode.size >= MAX_TRACKED_NODES) {
      // G4: drop oldest entries
      const drop = originalTextByNode.size - MAX_TRACKED_NODES + 100;
      let i = 0;
      for (const k of originalTextByNode.keys()) {
        if (i++ >= drop) break;
        originalTextByNode.delete(k);
      }
    }
    originalTextByNode.set(node, source);
  }

  function applyItemTranslation(item, t, gen) {
    if (!isGenCurrent(gen) || t == null || t === "") return false;
    const source = item.fullOriginal != null ? item.fullOriginal : item.value;
    seenSourceHashes.add(hashStr(source));
    outputHashes.add(hashStr(t));
    capSet(seenSourceHashes, MAX_HASH_SET);
    capSet(outputHashes, MAX_HASH_SET);

    return withOwnMutation(() => {
      if (item.kind === "text") {
        const node = item.node;
        if (!node) return false;
        if (!originalTextByNode.has(node)) trackOriginal(node, source);
        if (node.isConnected) node.nodeValue = t;
        return true;
      }
      if (item.kind === "attr") {
        const el = item.el;
        if (!el || !el.isConnected) return false;
        let bag = originalAttrsByEl.get(el);
        if (!bag) { bag = {}; originalAttrsByEl.set(el, bag); }
        if (bag[item.attr] == null) bag[item.attr] = source;
        el.setAttribute(item.attr, t);
        return true;
      }
      return false;
    });
  }

  async function translateLargeTextNode(item, gen) {
    const node = item.node;
    const full = item.fullOriginal != null ? item.fullOriginal : item.value;
    if (!node || !full || !isGenCurrent(gen)) return;
    if (!originalTextByNode.has(node)) trackOriginal(node, full);
    seenSourceHashes.add(hashStr(full));
    const slices = splitOnBoundaries(full, MAX_PACK_CHARS);
    let out = "";
    for (let i = 0; i < slices.length; i += 4) {
      if (!isGenCurrent(gen)) return;
      const group = slices.slice(i, i + 4);
      const results = await translateBatchViaBackground(group);
      if (!isGenCurrent(gen)) return;
      for (let j = 0; j < group.length; j++) {
        const r = results[j];
        out += r && r.ok ? r.translated : group[j];
      }
    }
    if (isGenCurrent(gen) && node.isConnected) {
      outputHashes.add(hashStr(out));
      withOwnMutation(() => { node.nodeValue = out; });
    }
  }

  async function translateLargeAttr(item, gen) {
    const el = item.el;
    const full = item.fullOriginal != null ? item.fullOriginal : item.value;
    if (!el || !full || !isGenCurrent(gen)) return;
    let bag = originalAttrsByEl.get(el);
    if (!bag) { bag = {}; originalAttrsByEl.set(el, bag); }
    if (bag[item.attr] == null) bag[item.attr] = full;
    seenSourceHashes.add(hashStr(full));
    const slices = splitOnBoundaries(full, MAX_PACK_CHARS);
    let out = "";
    for (const slice of slices) {
      if (!isGenCurrent(gen)) return;
      try { out += await translateViaBackground(slice); }
      catch { out += slice; }
    }
    if (isGenCurrent(gen) && el.isConnected) {
      outputHashes.add(hashStr(out));
      withOwnMutation(() => { el.setAttribute(item.attr, out); });
    }
  }

  async function translateChunkItems(items, gen) {
    if (!isGenCurrent(gen)) return;
    if (items.length === 1 && items[0]._isLargeText) {
      await translateLargeTextNode(items[0], gen); return;
    }
    if (items.length === 1 && items[0]._isLargeAttr) {
      await translateLargeAttr(items[0], gen); return;
    }
    const packed = packChunk(items);
    const translatedFull = await translateViaBackground(packed);
    if (!isGenCurrent(gen)) return;
    const parts = unpackChunk(translatedFull, items.length);
    items.forEach((item, i) => applyItemTranslation(item, parts[i], gen));
  }

  async function ensurePrivacyAccepted() {
    if (privacyAccepted) return true;
    if (!IS_TOP) {
      try {
        const s = await chrome.storage.local.get("deEnPrivacyAccepted");
        privacyAccepted = !!s.deEnPrivacyAccepted;
      } catch { /* ignore */ }
      return privacyAccepted;
    }
    showPrivacyPrompt(true);
    showBadge("Privacy consent required");
    return false;
  }

  async function acceptPrivacy() {
    privacyAccepted = true;
    await chrome.storage.local.set({ deEnPrivacyAccepted: true });
    showPrivacyPrompt(false);
    showBadge("Privacy accepted — translating…");
    if (!translated && phase === "idle") await translatePage();
  }

  function setUiEnglish(isEn) {
    if (fabEl) {
      fabEl.classList.toggle("is-english", isEn);
      fabEl.setAttribute("aria-checked", isEn ? "true" : "false");
    }
  }
  function setUiLoading(on) {
    if (fabEl) {
      fabEl.classList.toggle("is-loading", on);
      fabEl.setAttribute("aria-busy", on ? "true" : "false");
    }
  }
  function setProgress(done, total) {
    if (!progressEl) return;
    if (!total) {
      progressEl.hidden = true;
      progressEl.style.setProperty("--p", "0%");
      if (statusLineEl) statusLineEl.textContent = "";
      return;
    }
    progressEl.hidden = false;
    const pct = Math.round((done / total) * 100);
    progressEl.style.setProperty("--p", pct + "%");
    progressEl.setAttribute("aria-valuenow", String(pct));
    if (statusLineEl) statusLineEl.textContent = done + " / " + total;
  }

  function pruneDisconnected() {
    for (const node of [...originalTextByNode.keys()]) {
      if (!node.isConnected) originalTextByNode.delete(node);
    }
    for (const el of [...originalAttrsByEl.keys()]) {
      if (!el.isConnected) originalAttrsByEl.delete(el);
    }
  }

  async function translatePage({ quiet } = {}) {
    if (phase === "translating" || phase === "restoring") return;
    if (!(await ensurePrivacyAccepted())) {
      if (!quiet) showBadge("Accept privacy notice to translate");
      return;
    }
    if (sensitiveSite && !quiet) showBadge("Sensitive site — manual only");

    const gen = ++runGeneration;
    phase = "translating";
    lastError = false;
    lastErrorDetail = "";
    setUiLoading(true);
    setProgress(0, 1);
    if (!quiet) showBadge("Translating…");

    try {
      pruneDisconnected();
      const root = document.body || document.documentElement;
      const { textNodes, attrTargets } = await collectWorkAsync(root, gen);
      if (!isGenCurrent(gen)) return;
      const items = buildWorkItems(textNodes, attrTargets);

      if (!items.length) {
        if (!isGenCurrent(gen)) return;
        translated = originalTextByNode.size > 0 || originalAttrsByEl.size > 0;
        setUiEnglish(translated);
        setProgress(0, 0);
        if (!quiet) showBadge(translated ? "Already translated" : "Nothing to translate");
        if (translated) startObserver();
        return;
      }

      const chunks = chunkItems(items);
      const total = chunks.length;
      let done = 0;
      setProgress(0, total);

      const pool = await mapPool(chunks, CONCURRENCY, async (chunk) => {
        await translateChunkItems(chunk, gen);
        done++;
        if (isGenCurrent(gen)) {
          setProgress(done, total);
          if (!quiet) showBadge(`Translating ${done}/${total}…`, 4000);
        }
      }, gen);

      if (!isGenCurrent(gen)) return;
      pruneDisconnected();
      translated = originalTextByNode.size > 0 || originalAttrsByEl.size > 0;
      setUiEnglish(translated);
      if (translated) startObserver();
      lastRetranslateAt = Date.now();

      const failed = pool.failed;
      if (failed > 0 && failed < total) {
        lastErrorDetail = `Partial: ${total - failed}/${total} ok`;
        showBadge(lastErrorDetail);
        lastError = false;
      } else if (failed >= total && total > 0) {
        lastErrorDetail = "All chunks failed — rate limit or network?";
        showBadge(lastErrorDetail, 5000);
        lastError = true;
      } else {
        showBadge("Translated to English");
        lastError = false;
        lastErrorDetail = "";
      }
      pushActionState({ error: lastError });
    } catch (e) {
      if (!isGenCurrent(gen)) return;
      console.error("[DE-EN Translator]", e);
      lastErrorDetail = friendlyError(e);
      showBadge(lastErrorDetail, 5000);
      lastError = true;
      pushActionState({ error: true });
    } finally {
      if (isGenCurrent(gen)) {
        phase = "idle";
        setUiLoading(false);
        setProgress(0, 0);
        pushActionState({ error: lastError });
      }
    }
  }

  async function restorePage() {
    const gen = ++runGeneration;
    phase = "restoring";
    stopObserver();
    setUiLoading(false);
    setProgress(0, 0);
    await Promise.resolve();
    withOwnMutation(() => {
      for (const [node, original] of originalTextByNode.entries()) {
        if (node.isConnected) node.nodeValue = original;
      }
      originalTextByNode.clear();
      for (const [el, bag] of originalAttrsByEl.entries()) {
        if (!el.isConnected) continue;
        for (const [attr, val] of Object.entries(bag)) el.setAttribute(attr, val);
      }
      originalAttrsByEl.clear();
    });
    seenSourceHashes.clear();
    if (gen === runGeneration) {
      translated = false;
      lastError = false;
      lastErrorDetail = "";
      setUiEnglish(false);
      showBadge("Restored German");
      phase = "idle";
      pushActionState({ error: false });
    }
  }

  async function runToggleLocal() {
    if (phase === "translating") {
      showBadge("Cancelling…");
      await restorePage();
      return;
    }
    if (phase === "restoring") return;
    if (translated) await restorePage();
    else await translatePage();
  }

  async function runToggle() {
    if (IS_TOP) {
      try {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: "DE_EN_BROADCAST_TOGGLE" }, () => resolve());
        });
        return;
      } catch { /* fall through */ }
    }
    await runToggleLocal();
  }

  function scheduleQuietRetranslate() {
    if (!translated || phase !== "idle") return;
    const now = Date.now();
    const wait = Math.max(OBSERVER_DEBOUNCE_MS, MIN_RETRANSLATE_GAP_MS - (now - lastRetranslateAt));
    clearTimeout(retranslateTimer);
    retranslateTimer = setTimeout(() => {
      if (!translated || phase !== "idle" || document.hidden) return;
      lastRetranslateAt = Date.now();
      translatePage({ quiet: true });
    }, wait);
  }

  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((mutations) => {
      if (!translated || phase !== "idle" || applyingMutations || document.hidden) return;
      let relevant = false;
      for (const m of mutations) {
        if (m.type === "attributes") {
          const el = m.target;
          if (!el || el.id === "__de_en_host") continue;
          if (originalAttrsByEl.has(el)) originalAttrsByEl.delete(el);
          relevant = true; break;
        }
        if (m.type === "characterData") {
          const node = m.target;
          if (node && originalTextByNode.has(node)) originalTextByNode.delete(node);
          relevant = true; break;
        }
        if (m.type === "childList" && m.addedNodes && m.addedNodes.length) {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE && n.id === "__de_en_host") continue;
            relevant = true; break;
          }
          if (relevant) break;
        }
      }
      if (!relevant) return;
      clearTimeout(mutateTimer);
      mutateTimer = setTimeout(() => scheduleQuietRetranslate(), OBSERVER_DEBOUNCE_MS);
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS_TO_TRANSLATE,
    });
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    clearTimeout(mutateTimer);
    clearTimeout(retranslateTimer);
    mutateTimer = null;
    retranslateTimer = null;
  }

  // ---------- UI ----------
  function showBadge(text, ms = 2200) {
    if (!IS_TOP || !shadowRoot) return;
    // G5: always auto-hide (cap stuck toasts)
    const hideMs = ms > 0 ? ms : 3500;
    let badge = shadowRoot.getElementById("__de_en_translator_badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "__de_en_translator_badge";
      badge.setAttribute("role", "status");
      badge.setAttribute("aria-live", "polite");
      shadowRoot.appendChild(badge);
    }
    badge.textContent = "DE→EN: " + text;
    clearTimeout(badge._hideTimer);
    badge._hideTimer = setTimeout(() => {
      if (badge && badge.parentNode) badge.remove();
    }, hideMs);
  }

  function showPrivacyPrompt(show) {
    if (!privacyEl) return;
    privacyEl.hidden = !show;
    if (show && panelEl) {
      panelMinimized = false;
      applyPanelVisibility();
    }
  }

  function applyTheme() {
    if (!panelEl || !hostEl) return;
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = themeMode === "dark" || (themeMode === "auto" && prefersDark);
    const light = themeMode === "light" || (themeMode === "auto" && !prefersDark);
    panelEl.classList.toggle("theme-dark", dark);
    panelEl.classList.toggle("theme-light", light);
    if (unhideBtnEl) {
      unhideBtnEl.classList.toggle("theme-dark", dark);
      unhideBtnEl.classList.toggle("theme-light", light);
    }
  }

  function applyPanelPosition() {
    if (!panelEl) return;
    if (panelPos && typeof panelPos.top === "number") {
      panelEl.style.top = panelPos.top + "px";
      panelEl.style.right = "auto";
      panelEl.style.left = (panelPos.left != null ? panelPos.left : 16) + "px";
    } else {
      panelEl.style.top = "";
      panelEl.style.right = "";
      panelEl.style.left = "";
    }
    if (unhideBtnEl && panelPos) {
      unhideBtnEl.style.top = (panelPos.top || 16) + "px";
      unhideBtnEl.style.left = (panelPos.left != null ? panelPos.left : "") + "px";
      unhideBtnEl.style.right = panelPos.left != null ? "auto" : "";
    }
  }

  function applyPanelVisibility() {
    if (!panelEl || !hostEl) return;
    if (hiddenOnSite) {
      panelEl.classList.add("is-site-hidden");
      if (unhideBtnEl) unhideBtnEl.hidden = false;
      return;
    }
    panelEl.classList.remove("is-site-hidden");
    if (unhideBtnEl) unhideBtnEl.hidden = true;
    panelEl.classList.toggle("is-minimized", panelMinimized);
    if (minBtnEl) {
      minBtnEl.setAttribute("aria-expanded", panelMinimized ? "false" : "true");
      minBtnEl.title = panelMinimized ? "Expand" : "Minimize";
    }
  }

  function syncPanelControls() {
    if (autoSwitchEl) {
      autoSwitchEl.classList.toggle("is-on", globalAutoMode);
      autoSwitchEl.setAttribute("aria-checked", globalAutoMode ? "true" : "false");
      autoSwitchEl.disabled = sensitiveSite;
    }
    if (siteAutoSwitchEl) {
      const on = siteAutoOverride === true || (siteAutoOverride == null && globalAutoMode && !sensitiveSite);
      siteAutoSwitchEl.classList.toggle("is-on", !!on && siteAutoOverride !== false);
      siteAutoSwitchEl.classList.toggle("is-off-override", siteAutoOverride === false);
      siteAutoSwitchEl.disabled = sensitiveSite;
    }
    if (hideBtnEl) hideBtnEl.textContent = hiddenOnSite ? "Show on this site" : "Hide on this site";
    if (privacyEl) privacyEl.hidden = privacyAccepted;
    if (langSelectEl) langSelectEl.value = siteLangOverride || "auto";
    if (themeSelectEl) themeSelectEl.value = themeMode;
    setUiEnglish(translated);
    applyTheme();
  }

  function setupDrag(handle, panel) {
    let dragging = false;
    let startX = 0, startY = 0, origL = 0, origT = 0;
    const onDown = (e) => {
      if (e.button != null && e.button !== 0) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origL = rect.left;
      origT = rect.top;
      panel.classList.add("is-dragging");
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let left = Math.max(4, Math.min(window.innerWidth - 40, origL + dx));
      let top = Math.max(4, Math.min(window.innerHeight - 40, origT + dy));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove("is-dragging");
      const rect = panel.getBoundingClientRect();
      savePanelPos({ top: Math.round(rect.top), left: Math.round(rect.left) });
    };
    handle.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  async function injectShadowStyles(shadow) {
    const style = document.createElement("style");
    try {
      const res = await fetch(chrome.runtime.getURL("content.css"));
      style.textContent = (await res.text()) + extraShadowCss();
    } catch {
      style.textContent = extraShadowCss();
    }
    shadow.appendChild(style);
  }

  function extraShadowCss() {
    return `
#__de_en_host_root { all: initial; }
#__de_en_panel {
  z-index: 2147483000 !important;
  max-width: 240px;
}
#__de_en_panel.theme-light {
  background: rgba(255,255,255,.88) !important;
  color: #111 !important;
  border-color: rgba(0,0,0,.12) !important;
}
#__de_en_panel.theme-light #__de_en_title,
#__de_en_panel.theme-light #__de_en_auto_label,
#__de_en_panel.theme-light #__de_en_site_auto_label,
#__de_en_panel.theme-light #__de_en_status {
  color: rgba(0,0,0,.75) !important;
}
#__de_en_panel.theme-light #__de_en_hide_site {
  color: rgba(0,0,0,.65) !important;
  background: rgba(0,0,0,.05) !important;
  border-color: rgba(0,0,0,.08) !important;
}
#__de_en_panel.is-dragging { opacity: .92; cursor: grabbing; }
#__de_en_drag {
  all: initial;
  cursor: grab;
  font-size: 12px;
  color: rgba(255,255,255,.45);
  padding: 0 4px;
  font-family: sans-serif;
  user-select: none;
}
#__de_en_panel.theme-light #__de_en_drag { color: rgba(0,0,0,.35); }
#__de_en_progress {
  all: initial;
  display: block;
  height: 4px;
  width: 100%;
  border-radius: 4px;
  background: rgba(127,127,127,.25);
  overflow: hidden;
  margin-top: 4px;
}
#__de_en_progress[hidden] { display: none !important; }
#__de_en_progress::after {
  content: "";
  display: block;
  height: 100%;
  width: var(--p, 0%);
  background: #0a6cff;
  transition: width .15s ease;
}
#__de_en_status {
  all: initial;
  display: block;
  font-size: 10px;
  color: rgba(255,255,255,.65);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  margin-top: 2px;
  min-height: 12px;
}
#__de_en_privacy {
  all: initial; display: block; max-width: 220px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 11px; line-height: 1.35; color: rgba(255,255,255,.9);
  background: rgba(180, 60, 40, 0.35); border: 1px solid rgba(255,180,160,.3);
  border-radius: 10px; padding: 8px; margin-bottom: 4px;
}
#__de_en_privacy[hidden] { display: none !important; }
#__de_en_privacy_accept {
  all: initial; display: block; width: 100%; margin-top: 8px; text-align: center;
  cursor: pointer; padding: 6px 8px; border-radius: 8px; font-size: 11px; font-weight: 700;
  color: #111; background: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#__de_en_site_auto_row, #__de_en_lang_row, #__de_en_theme_row {
  all: initial; display: flex !important; align-items: center; justify-content: space-between;
  gap: 8px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#__de_en_site_auto_label, #__de_en_lang_label, #__de_en_theme_label {
  all: initial; font-size: 11px; font-weight: 600; color: rgba(255,255,255,.75);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#__de_en_lang_select, #__de_en_theme_select {
  all: initial; font-size: 11px; padding: 2px 4px; border-radius: 6px;
  background: rgba(255,255,255,.12); color: inherit;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  border: 1px solid rgba(127,127,127,.3); cursor: pointer;
}
#__de_en_sensitive {
  all: initial; display: block; font-size: 10px; color: #f9ab00;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#__de_en_sensitive[hidden] { display: none !important; }
#__de_en_unhide {
  all: initial; position: fixed !important; top: 16px !important; right: 16px !important;
  z-index: 2147483000 !important; cursor: pointer; padding: 6px 10px; border-radius: 999px;
  background: rgba(24,24,28,.85); color: #fff; font-size: 11px; font-weight: 700;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  border: 1px solid rgba(255,255,255,.2);
}
#__de_en_unhide.theme-light { background: rgba(255,255,255,.9); color: #111; border-color: rgba(0,0,0,.12); }
#__de_en_unhide[hidden] { display: none !important; }
#__de_en_panel.is-site-hidden #__de_en_header,
#__de_en_panel.is-site-hidden #__de_en_panel_body,
#__de_en_panel.is-site-hidden #__de_en_pill { display: none !important; }
#__de_en_site_auto_switch {
  all: initial; position: relative !important; display: block !important;
  width: 36px; height: 20px; border-radius: 999px; background: rgba(255,255,255,.18);
  cursor: pointer; border: none; padding: 0;
}
#__de_en_site_auto_switch.is-on { background: #34c759; }
#__de_en_site_auto_switch.is-off-override { background: #d93025; }
#__de_en_site_auto_switch .__de_en_auto_knob {
  all: initial; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; display: block; transition: transform .22s ease;
}
#__de_en_site_auto_switch.is-on .__de_en_auto_knob { transform: translateX(16px); }
#__de_en_pill_toggle {
  all: initial; display: none; margin-left: 6px; cursor: pointer; padding: 2px 6px;
  border-radius: 6px; font-size: 10px; font-weight: 700; color: #fff;
  background: #0a6cff; font-family: sans-serif;
}
#__de_en_panel.is-minimized #__de_en_pill_row { display: flex !important; align-items: center; gap: 4px; }
#__de_en_pill_row { all: initial; display: none; }
#__de_en_panel.is-minimized #__de_en_pill { display: inline-flex !important; }
@media (prefers-reduced-motion: reduce) {
  #__de_en_progress::after { transition: none !important; }
}
@media (forced-colors: active) {
  #__de_en_panel { border: 2px solid CanvasText !important; background: Canvas !important; color: CanvasText !important; }
}
`;
  }

  async function createPanel() {
    if (!IS_TOP) return;
    if (hostEl && hostEl.isConnected) return;

    hostEl = document.createElement("div");
    hostEl.id = "__de_en_host";
    shadowRoot = hostEl.attachShadow({ mode: "closed" });
    await injectShadowStyles(shadowRoot);

    const root = document.createElement("div");
    root.id = "__de_en_host_root";

    unhideBtnEl = document.createElement("button");
    unhideBtnEl.type = "button";
    unhideBtnEl.id = "__de_en_unhide";
    unhideBtnEl.textContent = "DE/EN";
    unhideBtnEl.title = "Show translator on this site";
    unhideBtnEl.hidden = true;
    unhideBtnEl.addEventListener("click", async () => {
      await setHiddenOnThisSite(false);
      await setMinimized(false);
      applyPanelVisibility();
      syncPanelControls();
      showBadge("Panel shown on this site");
    });

    panelEl = document.createElement("div");
    panelEl.id = "__de_en_panel";
    panelEl.setAttribute("role", "region");
    panelEl.setAttribute("aria-label", "German to English translator");

    privacyEl = document.createElement("div");
    privacyEl.id = "__de_en_privacy";
    privacyEl.hidden = true;
    privacyEl.innerHTML = "<strong>Privacy</strong><br/>Page text is sent to Google’s public translate endpoint. Sensitive sites block auto-translate.";
    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.id = "__de_en_privacy_accept";
    acceptBtn.textContent = "I understand — continue";
    acceptBtn.addEventListener("click", () => acceptPrivacy());
    privacyEl.appendChild(acceptBtn);

    const header = document.createElement("div");
    header.id = "__de_en_header";
    dragHandleEl = document.createElement("span");
    dragHandleEl.id = "__de_en_drag";
    dragHandleEl.textContent = "⠿";
    dragHandleEl.title = "Drag panel";
    const title = document.createElement("span");
    title.id = "__de_en_title";
    title.textContent = "DE → EN";
    minBtnEl = document.createElement("button");
    minBtnEl.type = "button";
    minBtnEl.id = "__de_en_min_btn";
    minBtnEl.textContent = "–";
    minBtnEl.addEventListener("click", async (e) => {
      e.stopPropagation();
      await setMinimized(!panelMinimized);
      applyPanelVisibility();
    });
    header.append(dragHandleEl, title, minBtnEl);
    setupDrag(dragHandleEl, panelEl);

    // I3: minimized row with explicit Translate button (no dblclick required)
    const pillRow = document.createElement("div");
    pillRow.id = "__de_en_pill_row";
    const pill = document.createElement("button");
    pill.type = "button";
    pill.id = "__de_en_pill";
    pill.textContent = "Expand";
    pill.title = "Expand panel";
    pill.addEventListener("click", async () => {
      await setMinimized(false);
      applyPanelVisibility();
    });
    const pillToggle = document.createElement("button");
    pillToggle.type = "button";
    pillToggle.id = "__de_en_pill_toggle";
    pillToggle.textContent = "Translate";
    pillToggle.title = "Toggle translation";
    pillToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      runToggle();
    });
    pillRow.append(pill, pillToggle);

    const body = document.createElement("div");
    body.id = "__de_en_panel_body";

    const sensitiveNote = document.createElement("div");
    sensitiveNote.id = "__de_en_sensitive";
    sensitiveNote.textContent = "Sensitive site: auto-translate off";
    sensitiveNote.hidden = !sensitiveSite;

    fabEl = document.createElement("button");
    fabEl.type = "button";
    fabEl.id = "__de_en_fab";
    fabEl.setAttribute("role", "switch");
    fabEl.setAttribute("aria-checked", "false");
    fabEl.setAttribute("aria-label", "Toggle German to English translation");
    fabEl.title = "Toggle translation (Alt+Shift+T)";
    const left = document.createElement("span");
    left.className = "__de_en_label left";
    left.textContent = "DE";
    const right = document.createElement("span");
    right.className = "__de_en_label right";
    right.textContent = "EN";
    const knob = document.createElement("span");
    knob.className = "__de_en_knob";
    const knobSpin = document.createElement("span");
    knobSpin.className = "__de_en_knob_spin";
    knob.appendChild(knobSpin);
    fabEl.append(left, right, knob);
    fabEl.addEventListener("click", () => runToggle());

    progressEl = document.createElement("div");
    progressEl.id = "__de_en_progress";
    progressEl.hidden = true;
    progressEl.setAttribute("role", "progressbar");
    progressEl.setAttribute("aria-valuemin", "0");
    progressEl.setAttribute("aria-valuemax", "100");
    statusLineEl = document.createElement("div");
    statusLineEl.id = "__de_en_status";

    const divider = document.createElement("span");
    divider.id = "__de_en_divider";

    const autoRow = document.createElement("div");
    autoRow.id = "__de_en_auto_row";
    const autoLabel = document.createElement("span");
    autoLabel.id = "__de_en_auto_label";
    autoLabel.textContent = "Auto (global)";
    autoSwitchEl = document.createElement("button");
    autoSwitchEl.type = "button";
    autoSwitchEl.id = "__de_en_auto_switch";
    autoSwitchEl.setAttribute("role", "switch");
    autoSwitchEl.appendChild(Object.assign(document.createElement("span"), { className: "__de_en_auto_knob" }));
    autoSwitchEl.addEventListener("click", async () => {
      if (sensitiveSite) { showBadge("Auto disabled on sensitive sites"); return; }
      await setGlobalAuto(!globalAutoMode);
      syncPanelControls();
      showBadge(globalAutoMode ? "Auto-translate: ON" : "Auto-translate: OFF");
      pushActionState();
      const det = detectPageLanguage(true);
      if (autoMode && !translated && phase === "idle") {
        if (det.autoOk) runToggle();
        else showBadge(det.isGerman ? "Low confidence — toggle manually" : "Page may not be German");
      }
    });
    autoRow.append(autoLabel, autoSwitchEl);

    const siteAutoRow = document.createElement("div");
    siteAutoRow.id = "__de_en_site_auto_row";
    const siteAutoLabel = document.createElement("span");
    siteAutoLabel.id = "__de_en_site_auto_label";
    siteAutoLabel.textContent = "Auto on this site";
    siteAutoSwitchEl = document.createElement("button");
    siteAutoSwitchEl.type = "button";
    siteAutoSwitchEl.id = "__de_en_site_auto_switch";
    siteAutoSwitchEl.appendChild(Object.assign(document.createElement("span"), { className: "__de_en_auto_knob" }));
    siteAutoSwitchEl.addEventListener("click", async () => {
      if (sensitiveSite) { showBadge("Auto disabled on sensitive sites"); return; }
      let next = null;
      if (siteAutoOverride == null) next = true;
      else if (siteAutoOverride === true) next = false;
      else next = null;
      await setSiteAutoOverride(next);
      syncPanelControls();
      showBadge(next === true ? "Site auto: ON" : next === false ? "Site auto: OFF" : "Site auto: inherit");
      pushActionState();
    });
    siteAutoRow.append(siteAutoLabel, siteAutoSwitchEl);

    // H3 language override
    const langRow = document.createElement("div");
    langRow.id = "__de_en_lang_row";
    const langLabel = document.createElement("span");
    langLabel.id = "__de_en_lang_label";
    langLabel.textContent = "Page language";
    langSelectEl = document.createElement("select");
    langSelectEl.id = "__de_en_lang_select";
    langSelectEl.innerHTML = '<option value="auto">Auto</option><option value="de">Force DE</option><option value="en">Force EN</option>';
    langSelectEl.addEventListener("change", async () => {
      const v = langSelectEl.value === "de" || langSelectEl.value === "en" ? langSelectEl.value : null;
      await setSiteLangOverride(v);
      const det = detectPageLanguage(true);
      showBadge(v ? `Lang override: ${v.toUpperCase()}` : `Detected: ${det.isGerman ? "DE" : "not DE"} (${Math.round(det.confidence * 100)}%)`);
    });
    langRow.append(langLabel, langSelectEl);

    // I10 theme
    const themeRow = document.createElement("div");
    themeRow.id = "__de_en_theme_row";
    const themeLabel = document.createElement("span");
    themeLabel.id = "__de_en_theme_label";
    themeLabel.textContent = "Theme";
    themeSelectEl = document.createElement("select");
    themeSelectEl.id = "__de_en_theme_select";
    themeSelectEl.innerHTML = '<option value="auto">Auto</option><option value="dark">Dark</option><option value="light">Light</option>';
    themeSelectEl.addEventListener("change", async () => {
      await setTheme(themeSelectEl.value);
    });
    themeRow.append(themeLabel, themeSelectEl);

    hideBtnEl = document.createElement("button");
    hideBtnEl.type = "button";
    hideBtnEl.id = "__de_en_hide_site";
    hideBtnEl.textContent = "Hide on this site";
    hideBtnEl.addEventListener("click", async () => {
      await setHiddenOnThisSite(!hiddenOnSite);
      syncPanelControls();
      applyPanelVisibility();
      showBadge(hiddenOnSite ? "Hidden on this site" : "Panel shown on this site");
    });

    body.append(
      sensitiveNote, fabEl, progressEl, statusLineEl, divider,
      autoRow, siteAutoRow, langRow, themeRow, hideBtnEl
    );
    panelEl.append(privacyEl, header, pillRow, body);
    root.append(unhideBtnEl, panelEl);
    shadowRoot.appendChild(root);
    document.documentElement.appendChild(hostEl);

    panelEl.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") {
        await setMinimized(true);
        applyPanelVisibility();
      }
    });

    // I: keyboard shortcut Alt+Shift+T
    window.addEventListener("keydown", onGlobalKey, true);
  }

  function onGlobalKey(e) {
    if (!(e.altKey && e.shiftKey && (e.key === "T" || e.key === "t"))) return;
    if (!IS_TOP) return;
    e.preventDefault();
    runToggle();
  }

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === "DE_EN_PING") {
      sendResponse({ ok: true, translated, autoMode, phase, sensitive: sensitiveSite });
      return false;
    }
    if (msg.type === "DE_EN_TOGGLE") {
      runToggleLocal().then(() => sendResponse({ ok: true, translated, phase }));
      return true;
    }
    if (msg.type === "DE_EN_SHOW_PANEL") {
      if (IS_TOP) {
        setHiddenOnThisSite(false).then(() => setMinimized(false).then(() => {
          applyPanelVisibility(); syncPanelControls();
        }));
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "DE_EN_TOOLBAR_FAIL") {
      if (IS_TOP) showBadge(msg.reason || "Cannot run on this page", 5000);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // I7: detect invalidated extension periodically
  const aliveTimer = setInterval(() => {
    try {
      if (!chrome.runtime || !chrome.runtime.id) throw new Error("dead");
      void chrome.runtime.getManifest();
    } catch {
      clearInterval(aliveTimer);
      if (IS_TOP) {
        try {
          showBadge("Extension reloaded — refresh page", 8000);
        } catch { /* ignore */ }
      }
    }
  }, 15000);

  window.__deEnCleanup = () => {
    try {
      runGeneration++;
      phase = "idle";
      stopObserver();
      clearInterval(aliveTimer);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* ignore */ }
      try { window.removeEventListener("keydown", onGlobalKey, true); } catch { /* ignore */ }
      if (hostEl) hostEl.remove();
      hostEl = null; shadowRoot = null; panelEl = null;
    } catch { /* ignore */ }
  };

  async function init() {
    if (IS_TOP) await createPanel();
    await loadPrefs();
    const det = detectPageLanguage(true);

    try {
      const stored = await chrome.storage.local.get("deEnSitePrefs");
      const site = ((stored.deEnSitePrefs || {})[hostname()] || {});
      if (site.minimized == null && IS_TOP && !det.isGerman && !autoMode) {
        panelMinimized = true;
      }
    } catch {
      if (IS_TOP && !det.isGerman && !autoMode) panelMinimized = true;
    }

    if (IS_TOP) {
      syncPanelControls();
      applyPanelVisibility();
      applyPanelPosition();
      applyTheme();
      if (!privacyAccepted) showPrivacyPrompt(true);
    }
    pushActionState();

    if (autoMode && !translated && det.autoOk && !sensitiveSite) {
      if (privacyAccepted) await translatePage();
      else if (IS_TOP) showBadge("Accept privacy to auto-translate");
    } else if (IS_TOP && autoMode && det.isGerman && !det.autoOk) {
      showBadge(`Maybe German (${Math.round(det.confidence * 100)}%) — toggle manually`);
    } else if (IS_TOP && autoMode && !det.isGerman) {
      showBadge("Auto on — page may not be German");
    } else if (IS_TOP && sensitiveSite && globalAutoMode) {
      showBadge("Sensitive site — auto blocked");
    }
  }

  if (document.documentElement) init();
  else document.addEventListener("DOMContentLoaded", init, { once: true });
})();
