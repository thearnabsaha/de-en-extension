// DE → EN Page Translator — content script
// A–F: state machine, rate-limited SW, shadow/iframes, SPA observer,
// per-site prefs, privacy gates, closed-shadow panel.

(() => {
  if (typeof window.__deEnCleanup === "function") {
    try {
      window.__deEnCleanup();
    } catch {
      /* ignore */
    }
  }

  // ---------- constants ----------

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CODE", "PRE",
    "TEXTAREA", "INPUT", "IFRAME", "CANVAS", "SELECT", "OPTION",
    "KBD", "SAMP", "MATH", "TEMPLATE", "OBJECT", "EMBED",
  ]);

  const ATTRS_TO_TRANSLATE = [
    "title", "alt", "aria-label", "placeholder", "aria-description",
  ];

  const MARKER_RE = /\u2060⟦DEEN:(\d+)⟧\u2060/g;
  const MARKER = (i) => `\u2060⟦DEEN:${i}⟧\u2060`;

  const MAX_PACK_CHARS = 1800;
  const MAX_ENCODED_HINT = 3400;
  const CONCURRENCY = 3;

  /** D1: minimum gap between quiet re-translates */
  const MIN_RETRANSLATE_GAP_MS = 1600;
  const OBSERVER_DEBOUNCE_MS = 700;

  const DEFAULT_HIDDEN_HOSTS = [
    "chrome.google.com",
    "chromewebstore.google.com",
  ];

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
    /(^|\.)local$/i,
    /^localhost$/i,
    /^127\.\d+\.\d+\.\d+$/,
    /^10\.\d+\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/,
  ];

  const IS_TOP = window === window.top;

  // ---------- state ----------

  let runGeneration = 0;
  let phase = "idle"; // idle | translating | restoring

  const originalTextByNode = new Map();
  const originalAttrsByEl = new Map();
  /** D3/D4: fingerprints of source strings already translated this session */
  const seenSourceHashes = new Set();
  /** D4: fingerprints of English outputs — never send back through sl=de */
  const outputHashes = new Set();

  let translated = false;
  let autoMode = false; // effective for this site
  let globalAutoMode = false;
  let siteAutoOverride = null; // null | true | false
  let panelMinimized = false;
  let hiddenOnSite = false;
  let lastError = false;
  let privacyAccepted = false;
  let sensitiveSite = false;

  let applyingMutations = false; // D1/D2: suppress self-triggered observer
  let lastRetranslateAt = 0;
  let retranslateTimer = null;

  let observer = null;
  let mutateTimer = null;

  /** Closed shadow host (F6) */
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

  // ---------- utils ----------

  function hostname() {
    try {
      return location.hostname || "";
    } catch {
      return "";
    }
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
        // Skip our host
        if (e.id === "__de_en_host") return false;
        let style;
        try {
          style = window.getComputedStyle(e);
        } catch {
          style = null;
        }
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
    if (el.closest && el.closest("[contenteditable=''], [contenteditable='true']")) {
      return true;
    }
    if (el.isContentEditable) return true;
    if (
      el.closest &&
      el.closest("[data-no-translate], .notranslate, #__de_en_host")
    ) {
      return true;
    }
    return false;
  }

  function looksGermanSample(text) {
    if (!text || text.length < 24) return false;
    const hits = (
      text.match(
        /\b(der|die|das|und|ist|nicht|mit|für|auf|ein|eine|ich|wir|sie|den|dem|des|von|zu|im|am|als|auch|oder|aber|wird|sind|hat|haben|kann|nach|bei|aus|über|wenn|nur|noch|schon|mehr|sehr|alle|diese|dieser|einem|einen|einer|werden|bitte|danke|uhr|heute|morgen)\b/gi
      ) || []
    ).length;
    const umlauts = (text.match(/[äöüÄÖÜß]/g) || []).length;
    return hits >= 3 || umlauts >= 2;
  }

  function looksMostlyEnglish(text) {
    if (!text || text.length < 12) return false;
    if (/[äöüÄÖÜß]/.test(text)) return false;
    const en = (
      text.match(
        /\b(the|and|is|are|was|were|for|with|this|that|from|your|have|has|will|not|you|our|can|all|about|more|been|their|which|would|there|what|when|who|how|also|into|than|then|only|other|some|such|these|those|please|click|login|logout|search|home|settings|privacy|cookie|accept)\b/gi
      ) || []
    ).length;
    const de = (
      text.match(
        /\b(der|die|das|und|ist|nicht|mit|für|ein|eine|ich|sie|den|dem|von|zu|auf|wird|sind|haben|oder|aber|auch)\b/gi
      ) || []
    ).length;
    return en >= 3 && en > de * 2;
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
    // D4: already translated this source, or looks like our English output
    if (seenSourceHashes.has(h)) return false;
    if (outputHashes.has(h)) return false;
    if (looksMostlyEnglish(text) && !looksGermanSample(text)) return false;
    return true;
  }

  function pageLooksGerman() {
    const lang = (
      document.documentElement.lang ||
      document.documentElement.getAttribute("xml:lang") ||
      ""
    )
      .toLowerCase()
      .trim();
    if (lang.startsWith("de")) return true;
    const meta = document.querySelector(
      'meta[http-equiv="content-language"], meta[name="language"]'
    );
    if (meta) {
      const c = (meta.getAttribute("content") || "").toLowerCase();
      if (c.startsWith("de")) return true;
    }
    let sample = "";
    try {
      const walker = document.createTreeWalker(
        document.body || document.documentElement,
        NodeFilter.SHOW_TEXT,
        null
      );
      let n;
      let len = 0;
      while ((n = walker.nextNode()) && len < 4000) {
        const t = n.nodeValue || "";
        sample += t + " ";
        len += t.length;
      }
    } catch {
      sample = (document.body && document.body.innerText) || "";
    }
    return looksGermanSample(sample.slice(0, 4000));
  }

  function encodedLen(s) {
    try {
      return encodeURIComponent(s).length;
    } catch {
      return s.length * 3;
    }
  }

  function computeEffectiveAuto() {
    if (sensitiveSite) return false; // F2: never auto on sensitive
    if (siteAutoOverride === true) return true;
    if (siteAutoOverride === false) return false;
    return globalAutoMode;
  }

  // ---------- storage (E) ----------

  async function loadPrefs() {
    const host = hostname();
    sensitiveSite = isSensitiveHost(host);
    try {
      const stored = await chrome.storage.local.get([
        "deEnAutoMode",
        "deEnSitePrefs",
        "deEnHiddenHosts",
        "deEnPrivacyAccepted",
      ]);
      globalAutoMode = !!stored.deEnAutoMode;
      privacyAccepted = !!stored.deEnPrivacyAccepted;

      const sitePrefs = stored.deEnSitePrefs && typeof stored.deEnSitePrefs === "object"
        ? stored.deEnSitePrefs
        : {};
      const site = sitePrefs[host] || {};

      // E1: minimize is per-site
      panelMinimized = site.minimized != null ? !!site.minimized : false;
      // E5: per-site auto override
      siteAutoOverride =
        site.auto === true ? true : site.auto === false ? false : null;

      // E4: always union default hidden hosts
      const userHidden = Array.isArray(stored.deEnHiddenHosts)
        ? stored.deEnHiddenHosts
        : [];
      const hiddenSet = new Set([...DEFAULT_HIDDEN_HOSTS, ...userHidden]);
      hiddenOnSite = !!site.hidden || hiddenSet.has(host);

      autoMode = computeEffectiveAuto();
    } catch {
      globalAutoMode = false;
      autoMode = false;
      panelMinimized = false;
      hiddenOnSite = DEFAULT_HIDDEN_HOSTS.includes(host);
      privacyAccepted = false;
      siteAutoOverride = null;
      sensitiveSite = isSensitiveHost(host);
    }
  }

  async function patchSitePrefs(patch) {
    const host = hostname();
    if (!host) return;
    let sitePrefs = {};
    try {
      const stored = await chrome.storage.local.get("deEnSitePrefs");
      sitePrefs =
        stored.deEnSitePrefs && typeof stored.deEnSitePrefs === "object"
          ? { ...stored.deEnSitePrefs }
          : {};
    } catch {
      sitePrefs = {};
    }
    sitePrefs[host] = { ...(sitePrefs[host] || {}), ...patch };
    await chrome.storage.local.set({ deEnSitePrefs: sitePrefs });
  }

  async function setHiddenOnThisSite(hide) {
    const host = hostname();
    if (!host) return;
    hiddenOnSite = hide;
    await patchSitePrefs({ hidden: hide });

    // Also maintain flat list for defaults merge / migration
    try {
      const stored = await chrome.storage.local.get("deEnHiddenHosts");
      let list = Array.isArray(stored.deEnHiddenHosts)
        ? stored.deEnHiddenHosts.slice()
        : [];
      if (hide) {
        if (!list.includes(host)) list.push(host);
      } else {
        list = list.filter((h) => h !== host);
      }
      await chrome.storage.local.set({ deEnHiddenHosts: list });
    } catch {
      /* ignore */
    }
  }

  async function setMinimized(min) {
    panelMinimized = min;
    await patchSitePrefs({ minimized: min });
  }

  async function setSiteAutoOverride(value) {
    // value: true | false | null
    siteAutoOverride = value;
    await patchSitePrefs({ auto: value });
    autoMode = computeEffectiveAuto();
  }

  async function setGlobalAuto(on) {
    globalAutoMode = on;
    await chrome.storage.local.set({ deEnAutoMode: on });
    autoMode = computeEffectiveAuto();
  }

  function pushActionState(extra = {}) {
    if (!IS_TOP) return;
    try {
      chrome.runtime.sendMessage({
        type: "DE_EN_ACTION_STATE",
        translated,
        auto: autoMode,
        error: lastError,
        sensitive: sensitiveSite,
        ...extra,
      });
    } catch {
      /* ignore */
    }
  }

  // E7: sync UI when prefs change in another tab
  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    const host = hostname();
    let needUi = false;

    if (changes.deEnAutoMode) {
      globalAutoMode = !!changes.deEnAutoMode.newValue;
      autoMode = computeEffectiveAuto();
      needUi = true;
    }
    if (changes.deEnPrivacyAccepted) {
      privacyAccepted = !!changes.deEnPrivacyAccepted.newValue;
      needUi = true;
    }
    if (changes.deEnSitePrefs) {
      const sitePrefs = changes.deEnSitePrefs.newValue || {};
      const site = sitePrefs[host] || {};
      if (site.minimized != null) panelMinimized = !!site.minimized;
      if (site.hidden != null) hiddenOnSite = !!site.hidden;
      siteAutoOverride =
        site.auto === true ? true : site.auto === false ? false : null;
      autoMode = computeEffectiveAuto();
      needUi = true;
    }
    if (changes.deEnHiddenHosts) {
      const userHidden = Array.isArray(changes.deEnHiddenHosts.newValue)
        ? changes.deEnHiddenHosts.newValue
        : [];
      const hiddenSet = new Set([...DEFAULT_HIDDEN_HOSTS, ...userHidden]);
      // site.hidden still wins via site prefs path; refresh union
      if (!hiddenOnSite || hiddenSet.has(host)) {
        // re-evaluate: need site.hidden too — reload async
        loadPrefs().then(() => {
          syncPanelControls();
          applyPanelVisibility();
          pushActionState();
        });
        return;
      }
    }

    if (needUi) {
      syncPanelControls();
      applyPanelVisibility();
      pushActionState();
    }
  }

  try {
    chrome.storage.onChanged.addListener(onStorageChanged);
  } catch {
    /* ignore */
  }

  // ---------- DOM collection ----------

  function walkComposedTree(root, onText, onElement) {
    if (!root) return;
    const visit = (node) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        onText(node);
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {Element} */ (node);
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

  function collectTextNodes(root) {
    const nodes = [];
    walkComposedTree(root, (node) => {
      const text = node.nodeValue;
      if (!text || !text.trim()) return;
      const parent = node.parentElement;
      if (!parent) return;
      if (shouldSkipElement(parent)) return;
      let p = parent;
      while (p) {
        if (p.nodeType === 1 && SKIP_TAGS.has(p.tagName)) return;
        if (p.nodeType === 1 && shouldSkipElement(p)) return;
        p = nextAncestor(p);
      }
      if (!isVisible(parent)) return;
      if (originalTextByNode.has(node)) return;
      if (!shouldTranslateText(text)) return;
      nodes.push(node);
    });
    return nodes;
  }

  function collectAttrTargets(root) {
    const out = [];
    const seen = new Set();
    walkComposedTree(root, () => {}, (el) => {
      if (seen.has(el)) return;
      seen.add(el);
      if (shouldSkipElement(el)) return;
      if (!isVisible(el) && el.tagName !== "IMG") return;
      const existing = originalAttrsByEl.get(el) || {};
      const pending = {};
      for (const attr of ATTRS_TO_TRANSLATE) {
        if (existing[attr] != null) continue;
        const val = el.getAttribute(attr);
        if (!val || !val.trim()) continue;
        if (!shouldTranslateText(val)) continue;
        pending[attr] = val;
      }
      if (Object.keys(pending).length) out.push({ el, attrs: pending });
    });
    return out;
  }

  function buildWorkItems(textNodes, attrTargets) {
    const items = [];
    for (const node of textNodes) {
      items.push({
        kind: "text",
        node,
        value: node.nodeValue,
        fullOriginal: node.nodeValue,
      });
    }
    for (const { el, attrs } of attrTargets) {
      for (const [attr, value] of Object.entries(attrs)) {
        items.push({ kind: "attr", el, attr, value, fullOriginal: value });
      }
    }
    return items;
  }

  function packChunk(items) {
    return items
      .map((it, i) => it.value + (i < items.length - 1 ? MARKER(i) : ""))
      .join("");
  }

  function splitOnBoundaries(text, maxChars) {
    if (text.length <= maxChars && encodedLen(text) <= MAX_ENCODED_HINT) {
      return [text];
    }
    const parts = [];
    let rest = text;
    while (rest.length) {
      if (rest.length <= maxChars && encodedLen(rest) <= MAX_ENCODED_HINT) {
        parts.push(rest);
        break;
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
        if (idx >= minBreak) {
          breakAt = idx + sep.length;
          break;
        }
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
    const flush = () => {
      if (current.length) {
        chunks.push(current);
        current = [];
      }
    };
    for (const item of items) {
      const piece = item.value;
      if (
        item.kind === "text" &&
        (encodedLen(piece) > MAX_ENCODED_HINT || piece.length > MAX_PACK_CHARS)
      ) {
        flush();
        chunks.push([{ ...item, _isLargeText: true }]);
        continue;
      }
      if (
        item.kind === "attr" &&
        (encodedLen(piece) > MAX_ENCODED_HINT || piece.length > MAX_PACK_CHARS)
      ) {
        flush();
        chunks.push([{ ...item, _isLargeAttr: true }]);
        continue;
      }
      const trial = current.concat([item]);
      const packed = packChunk(trial);
      if (
        current.length &&
        (packed.length > MAX_PACK_CHARS || encodedLen(packed) > MAX_ENCODED_HINT)
      ) {
        flush();
      }
      current.push(item);
    }
    flush();
    return chunks;
  }

  function unpackChunk(translatedFull, count) {
    if (count === 1) return [translatedFull == null ? "" : translatedFull];
    const re = new RegExp(MARKER_RE.source, "g");
    const parts = [];
    let last = 0;
    let m;
    const src = translatedFull || "";
    while ((m = re.exec(src)) !== null) {
      parts.push(src.slice(last, m.index));
      last = m.index + m[0].length;
    }
    parts.push(src.slice(last));
    if (parts.length !== count) {
      throw new Error(
        "Marker remap failed: expected " + count + " parts, got " + parts.length
      );
    }
    return parts;
  }

  // ---------- network ----------

  function translateViaBackground(text) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "DE_EN_TRANSLATE", text }, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res || !res.ok) {
            reject(new Error((res && res.error) || "Translation failed"));
            return;
          }
          resolve(res.translated);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function translateBatchViaBackground(texts) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: "DE_EN_TRANSLATE_BATCH", texts },
          (res) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!res || !res.ok) {
              reject(new Error((res && res.error) || "Batch failed"));
              return;
            }
            resolve(res.results || []);
          }
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  async function mapPool(items, limit, fn, gen) {
    const results = new Array(items.length);
    let next = 0;
    let active = 0;
    let failed = 0;
    return new Promise((resolve) => {
      const kick = () => {
        if (gen !== runGeneration && active === 0) {
          resolve({ results, failed });
          return;
        }
        while (active < limit && next < items.length && gen === runGeneration) {
          const i = next++;
          active++;
          Promise.resolve(fn(items[i], i))
            .then((r) => {
              results[i] = r;
            })
            .catch(() => {
              failed++;
              results[i] = null;
            })
            .finally(() => {
              active--;
              if ((next >= items.length || gen !== runGeneration) && active === 0) {
                resolve({ results, failed });
              } else {
                kick();
              }
            });
        }
        if (items.length === 0) resolve({ results, failed });
      };
      kick();
    });
  }

  function isGenCurrent(gen) {
    return gen === runGeneration;
  }

  function withOwnMutation(fn) {
    applyingMutations = true;
    try {
      return fn();
    } finally {
      // defer clear so MutationObserver microtasks see the flag
      queueMicrotask(() => {
        applyingMutations = false;
      });
    }
  }

  function applyItemTranslation(item, t, gen) {
    if (!isGenCurrent(gen)) return false;
    if (t == null || t === "") return false;

    const source = item.fullOriginal != null ? item.fullOriginal : item.value;
    seenSourceHashes.add(hashStr(source));
    outputHashes.add(hashStr(t));

    return withOwnMutation(() => {
      if (item.kind === "text") {
        const node = item.node;
        if (!node) return false;
        if (!originalTextByNode.has(node)) {
          originalTextByNode.set(node, source);
        }
        if (node.isConnected) node.nodeValue = t;
        return true;
      }
      if (item.kind === "attr") {
        const el = item.el;
        if (!el || !el.isConnected) return false;
        let bag = originalAttrsByEl.get(el);
        if (!bag) {
          bag = {};
          originalAttrsByEl.set(el, bag);
        }
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
    if (!originalTextByNode.has(node)) originalTextByNode.set(node, full);
    seenSourceHashes.add(hashStr(full));

    const slices = splitOnBoundaries(full, MAX_PACK_CHARS);
    let out = "";
    const BATCH = 4;
    for (let i = 0; i < slices.length; i += BATCH) {
      if (!isGenCurrent(gen)) return;
      const group = slices.slice(i, i + BATCH);
      const results = await translateBatchViaBackground(group);
      if (!isGenCurrent(gen)) return;
      for (let j = 0; j < group.length; j++) {
        const r = results[j];
        out += r && r.ok ? r.translated : group[j];
      }
    }
    if (isGenCurrent(gen) && node.isConnected) {
      outputHashes.add(hashStr(out));
      withOwnMutation(() => {
        node.nodeValue = out;
      });
    }
  }

  async function translateLargeAttr(item, gen) {
    const el = item.el;
    const full = item.fullOriginal != null ? item.fullOriginal : item.value;
    if (!el || !full || !isGenCurrent(gen)) return;
    let bag = originalAttrsByEl.get(el);
    if (!bag) {
      bag = {};
      originalAttrsByEl.set(el, bag);
    }
    if (bag[item.attr] == null) bag[item.attr] = full;
    seenSourceHashes.add(hashStr(full));

    const slices = splitOnBoundaries(full, MAX_PACK_CHARS);
    let out = "";
    for (const slice of slices) {
      if (!isGenCurrent(gen)) return;
      try {
        out += await translateViaBackground(slice);
      } catch {
        out += slice;
      }
    }
    if (isGenCurrent(gen) && el.isConnected) {
      outputHashes.add(hashStr(out));
      withOwnMutation(() => {
        el.setAttribute(item.attr, out);
      });
    }
  }

  async function translateChunkItems(items, gen) {
    if (!isGenCurrent(gen)) return;
    if (items.length === 1 && items[0]._isLargeText) {
      await translateLargeTextNode(items[0], gen);
      return;
    }
    if (items.length === 1 && items[0]._isLargeAttr) {
      await translateLargeAttr(items[0], gen);
      return;
    }
    const packed = packChunk(items);
    const translatedFull = await translateViaBackground(packed);
    if (!isGenCurrent(gen)) return;
    const parts = unpackChunk(translatedFull, items.length);
    items.forEach((item, i) => applyItemTranslation(item, parts[i], gen));
  }

  // ---------- privacy gate (F1) ----------

  async function ensurePrivacyAccepted() {
    if (privacyAccepted) return true;
    if (!IS_TOP) {
      // nested frames: wait for top storage
      try {
        const s = await chrome.storage.local.get("deEnPrivacyAccepted");
        privacyAccepted = !!s.deEnPrivacyAccepted;
      } catch {
        /* ignore */
      }
      return privacyAccepted;
    }
    // Show privacy panel section and wait for accept
    showPrivacyPrompt(true);
    showBadge("Privacy consent required");
    return false;
  }

  async function acceptPrivacy() {
    privacyAccepted = true;
    await chrome.storage.local.set({ deEnPrivacyAccepted: true });
    showPrivacyPrompt(false);
    showBadge("Privacy accepted — translating…");
    if (!translated && phase === "idle") {
      await translatePage();
    }
  }

  // ---------- translate / restore ----------

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

    if (sensitiveSite && !quiet) {
      showBadge("Sensitive site — manual only");
    }

    const gen = ++runGeneration;
    phase = "translating";
    lastError = false;
    setUiLoading(true);
    if (!quiet) showBadge("Translating…");

    try {
      pruneDisconnected();
      const root = document.body || document.documentElement;
      const textNodes = collectTextNodes(root);
      const attrTargets = collectAttrTargets(root);
      const items = buildWorkItems(textNodes, attrTargets);

      if (!items.length) {
        if (!isGenCurrent(gen)) return;
        translated = originalTextByNode.size > 0 || originalAttrsByEl.size > 0;
        setUiEnglish(translated);
        if (!quiet) {
          showBadge(translated ? "Already translated" : "Nothing to translate");
        }
        if (translated) startObserver();
        return;
      }

      const chunks = chunkItems(items);
      const total = chunks.length;
      let done = 0;

      const pool = await mapPool(
        chunks,
        CONCURRENCY,
        async (chunk) => {
          await translateChunkItems(chunk, gen);
          done++;
          if (!quiet && isGenCurrent(gen)) {
            showBadge(`Translating ${done}/${total}…`, 0);
          }
        },
        gen
      );

      if (!isGenCurrent(gen)) return;

      pruneDisconnected();
      translated = originalTextByNode.size > 0 || originalAttrsByEl.size > 0;
      setUiEnglish(translated);
      if (translated) startObserver();
      lastRetranslateAt = Date.now();

      const failed = pool.failed;
      if (failed > 0 && failed < total) {
        showBadge(`Partial: ${total - failed}/${total} ok`);
        lastError = false;
      } else if (failed >= total && total > 0) {
        showBadge("Translation failed");
        lastError = true;
      } else {
        showBadge("Translated to English");
        lastError = false;
      }
      pushActionState({ error: lastError });
    } catch (e) {
      if (!isGenCurrent(gen)) return;
      console.error("[DE-EN Translator]", e);
      showBadge("Translation failed");
      lastError = true;
      pushActionState({ error: true });
    } finally {
      if (isGenCurrent(gen)) {
        phase = "idle";
        setUiLoading(false);
        pushActionState({ error: lastError });
      }
    }
  }

  async function restorePage() {
    const gen = ++runGeneration;
    phase = "restoring";
    stopObserver();
    setUiLoading(false);
    await Promise.resolve();

    withOwnMutation(() => {
      for (const [node, original] of originalTextByNode.entries()) {
        if (node.isConnected) node.nodeValue = original;
      }
      originalTextByNode.clear();
      for (const [el, bag] of originalAttrsByEl.entries()) {
        if (!el.isConnected) continue;
        for (const [attr, val] of Object.entries(bag)) {
          el.setAttribute(attr, val);
        }
      }
      originalAttrsByEl.clear();
    });

    // Keep outputHashes so we don't re-DE→EN the same English if SPA reuses it
    // Clear source hashes that were restored so user can translate again if text returns as German
    seenSourceHashes.clear();

    if (gen === runGeneration) {
      translated = false;
      lastError = false;
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
          chrome.runtime.sendMessage({ type: "DE_EN_BROADCAST_TOGGLE" }, () =>
            resolve()
          );
        });
        return;
      } catch {
        /* fall through */
      }
    }
    await runToggleLocal();
  }

  // ---------- MutationObserver (D1, D2) ----------

  function scheduleQuietRetranslate() {
    if (!translated || phase !== "idle") return;
    const now = Date.now();
    const wait = Math.max(
      OBSERVER_DEBOUNCE_MS,
      MIN_RETRANSLATE_GAP_MS - (now - lastRetranslateAt)
    );
    clearTimeout(retranslateTimer);
    retranslateTimer = setTimeout(() => {
      if (!translated || phase !== "idle") return;
      if (document.hidden) return; // D1: pause when tab hidden
      lastRetranslateAt = Date.now();
      translatePage({ quiet: true });
    }, wait);
  }

  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((mutations) => {
      if (!translated || phase !== "idle") return;
      if (applyingMutations) return;
      if (document.hidden) return;

      let relevant = false;
      for (const m of mutations) {
        if (m.type === "attributes") {
          const el = m.target;
          if (!el || el.id === "__de_en_host") continue;
          if (originalAttrsByEl.has(el)) {
            // D2/D3: attr changed under us — drop tracking so we re-translate
            originalAttrsByEl.delete(el);
          }
          relevant = true;
          break;
        }
        if (m.type === "characterData") {
          // D2: in-place text edits
          const node = m.target;
          if (node && originalTextByNode.has(node)) {
            originalTextByNode.delete(node);
          }
          relevant = true;
          break;
        }
        if (m.type === "childList") {
          if (m.addedNodes && m.addedNodes.length) {
            // Ignore pure removals of our unrelated nodes
            for (const n of m.addedNodes) {
              if (n.nodeType === Node.ELEMENT_NODE && n.id === "__de_en_host") {
                continue;
              }
              relevant = true;
              break;
            }
            if (relevant) break;
          }
        }
      }
      if (!relevant) return;

      clearTimeout(mutateTimer);
      mutateTimer = setTimeout(() => scheduleQuietRetranslate(), OBSERVER_DEBOUNCE_MS);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true, // D2
      characterDataOldValue: false,
      attributes: true,
      attributeFilter: ATTRS_TO_TRANSLATE,
    });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(mutateTimer);
    clearTimeout(retranslateTimer);
    mutateTimer = null;
    retranslateTimer = null;
  }

  // ---------- UI in closed shadow (F6) ----------

  function showBadge(text, ms = 2200) {
    if (!IS_TOP || !shadowRoot) return;
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
    if (ms > 0) {
      badge._hideTimer = setTimeout(() => {
        if (badge && badge.parentNode) badge.remove();
      }, ms);
    }
  }

  function showPrivacyPrompt(show) {
    if (!privacyEl) return;
    privacyEl.hidden = !show;
    if (show && panelEl) {
      panelMinimized = false;
      applyPanelVisibility();
    }
  }

  function applyPanelVisibility() {
    if (!panelEl || !hostEl) return;

    // E3: when hidden, show only unhide chip
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
      minBtnEl.title = panelMinimized ? "Expand translator panel" : "Minimize panel";
      minBtnEl.setAttribute(
        "aria-label",
        panelMinimized ? "Expand translator panel" : "Minimize translator panel"
      );
    }
  }

  function syncPanelControls() {
    if (autoSwitchEl) {
      autoSwitchEl.classList.toggle("is-on", globalAutoMode);
      autoSwitchEl.setAttribute("aria-checked", globalAutoMode ? "true" : "false");
      if (sensitiveSite) {
        autoSwitchEl.disabled = true;
        autoSwitchEl.title = "Auto-translate disabled on sensitive sites";
      } else {
        autoSwitchEl.disabled = false;
        autoSwitchEl.title = "Automatically translate pages (global)";
      }
    }
    if (siteAutoSwitchEl) {
      const on =
        siteAutoOverride === true ||
        (siteAutoOverride == null && globalAutoMode && !sensitiveSite);
      siteAutoSwitchEl.classList.toggle("is-on", !!on && siteAutoOverride !== false);
      siteAutoSwitchEl.classList.toggle("is-off-override", siteAutoOverride === false);
      siteAutoSwitchEl.setAttribute(
        "aria-checked",
        siteAutoOverride === false ? "false" : on ? "true" : "false"
      );
      siteAutoSwitchEl.disabled = sensitiveSite;
    }
    if (hideBtnEl) {
      hideBtnEl.textContent = hiddenOnSite ? "Show on this site" : "Hide on this site";
    }
    if (privacyEl) {
      privacyEl.hidden = privacyAccepted;
    }
    setUiEnglish(translated);
  }

  async function injectShadowStyles(shadow) {
    const style = document.createElement("style");
    try {
      const url = chrome.runtime.getURL("content.css");
      const res = await fetch(url);
      style.textContent = (await res.text()) + extraShadowCss();
    } catch {
      style.textContent = extraShadowCss();
    }
    shadow.appendChild(style);
  }

  function extraShadowCss() {
    return `
#__de_en_host_root { all: initial; }
#__de_en_privacy {
  all: initial;
  display: block;
  max-width: 220px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 11px;
  line-height: 1.35;
  color: rgba(255,255,255,.9);
  background: rgba(180, 60, 40, 0.35);
  border: 1px solid rgba(255,180,160,.3);
  border-radius: 10px;
  padding: 8px;
  margin-bottom: 4px;
}
#__de_en_privacy[hidden] { display: none !important; }
#__de_en_privacy strong { color: #fff; }
#__de_en_privacy_accept {
  all: initial;
  display: block;
  width: 100%;
  margin-top: 8px;
  text-align: center;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 700;
  color: #111;
  background: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#__de_en_site_auto_row {
  all: initial;
  display: flex !important;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#__de_en_site_auto_label {
  all: initial;
  font-size: 11px;
  font-weight: 600;
  color: rgba(255,255,255,.75);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#__de_en_sensitive {
  all: initial;
  display: block;
  font-size: 10px;
  color: #f9ab00;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  margin-top: 2px;
}
#__de_en_sensitive[hidden] { display: none !important; }
#__de_en_unhide {
  all: initial;
  position: fixed !important;
  top: 16px !important;
  right: 16px !important;
  z-index: 2147483647 !important;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(24,24,28,.85);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  border: 1px solid rgba(255,255,255,.2);
  box-shadow: 0 2px 10px rgba(0,0,0,.3);
}
#__de_en_unhide[hidden] { display: none !important; }
#__de_en_panel.is-site-hidden #__de_en_header,
#__de_en_panel.is-site-hidden #__de_en_panel_body,
#__de_en_panel.is-site-hidden #__de_en_pill {
  display: none !important;
}
#__de_en_site_auto_switch {
  all: initial;
  position: relative !important;
  display: block !important;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: rgba(255,255,255,.18);
  cursor: pointer;
  border: none;
  padding: 0;
}
#__de_en_site_auto_switch.is-on { background: #34c759; }
#__de_en_site_auto_switch.is-off-override { background: #d93025; }
#__de_en_site_auto_switch .__de_en_auto_knob {
  all: initial;
  position: absolute;
  top: 2px; left: 2px;
  width: 16px; height: 16px;
  border-radius: 50%;
  background: #fff;
  display: block;
  transition: transform .22s ease;
}
#__de_en_site_auto_switch.is-on .__de_en_auto_knob { transform: translateX(16px); }
`;
  }

  async function createPanel() {
    if (!IS_TOP) return;
    if (hostEl && hostEl.isConnected) return;

    hostEl = document.createElement("div");
    hostEl.id = "__de_en_host";
    // closed shadow — page JS cannot query inside (F6)
    shadowRoot = hostEl.attachShadow({ mode: "closed" });
    await injectShadowStyles(shadowRoot);

    const root = document.createElement("div");
    root.id = "__de_en_host_root";

    // Unhide chip (E3)
    unhideBtnEl = document.createElement("button");
    unhideBtnEl.type = "button";
    unhideBtnEl.id = "__de_en_unhide";
    unhideBtnEl.textContent = "DE/EN";
    unhideBtnEl.title = "Show translator on this site";
    unhideBtnEl.hidden = true;
    unhideBtnEl.addEventListener("click", async () => {
      await setHiddenOnThisSite(false);
      panelMinimized = false;
      await setMinimized(false);
      applyPanelVisibility();
      syncPanelControls();
      showBadge("Panel shown on this site");
    });

    panelEl = document.createElement("div");
    panelEl.id = "__de_en_panel";
    panelEl.setAttribute("role", "region");
    panelEl.setAttribute("aria-label", "German to English translator");

    // Privacy (F1)
    privacyEl = document.createElement("div");
    privacyEl.id = "__de_en_privacy";
    privacyEl.hidden = true;
    privacyEl.innerHTML =
      "<strong>Privacy</strong><br/>Page text is sent to Google’s public translate endpoint. Do not use on private/mail/banking pages. Sensitive sites block auto-translate.";
    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.id = "__de_en_privacy_accept";
    acceptBtn.textContent = "I understand — continue";
    acceptBtn.addEventListener("click", () => acceptPrivacy());
    privacyEl.appendChild(acceptBtn);

    const header = document.createElement("div");
    header.id = "__de_en_header";
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
    header.appendChild(title);
    header.appendChild(minBtnEl);

    const pill = document.createElement("button");
    pill.type = "button";
    pill.id = "__de_en_pill";
    pill.textContent = "DE/EN";
    pill.title = "Open translator · double-click to toggle";
    pill.addEventListener("click", async () => {
      await setMinimized(false);
      applyPanelVisibility();
    });
    pill.addEventListener("dblclick", (e) => {
      e.preventDefault();
      runToggle();
    });

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

    const divider = document.createElement("span");
    divider.id = "__de_en_divider";

    // Global auto
    const autoRow = document.createElement("div");
    autoRow.id = "__de_en_auto_row";
    const autoLabel = document.createElement("span");
    autoLabel.id = "__de_en_auto_label";
    autoLabel.textContent = "Auto (global)";
    autoSwitchEl = document.createElement("button");
    autoSwitchEl.type = "button";
    autoSwitchEl.id = "__de_en_auto_switch";
    autoSwitchEl.setAttribute("role", "switch");
    const autoKnob = document.createElement("span");
    autoKnob.className = "__de_en_auto_knob";
    autoSwitchEl.appendChild(autoKnob);
    autoSwitchEl.addEventListener("click", async () => {
      if (sensitiveSite) {
        showBadge("Auto disabled on sensitive sites");
        return;
      }
      await setGlobalAuto(!globalAutoMode);
      syncPanelControls();
      showBadge(globalAutoMode ? "Auto-translate: ON" : "Auto-translate: OFF");
      pushActionState();
      if (autoMode && !translated && phase === "idle") {
        if (pageLooksGerman()) runToggle();
        else showBadge("Page may not be German — toggle manually");
      }
    });
    autoRow.append(autoLabel, autoSwitchEl);

    // Per-site auto override (E5)
    const siteAutoRow = document.createElement("div");
    siteAutoRow.id = "__de_en_site_auto_row";
    const siteAutoLabel = document.createElement("span");
    siteAutoLabel.id = "__de_en_site_auto_label";
    siteAutoLabel.textContent = "Auto on this site";
    siteAutoSwitchEl = document.createElement("button");
    siteAutoSwitchEl.type = "button";
    siteAutoSwitchEl.id = "__de_en_site_auto_switch";
    siteAutoSwitchEl.setAttribute("role", "switch");
    siteAutoSwitchEl.title = "Override auto for this hostname (off = red)";
    const siteKnob = document.createElement("span");
    siteKnob.className = "__de_en_auto_knob";
    siteAutoSwitchEl.appendChild(siteKnob);
    siteAutoSwitchEl.addEventListener("click", async () => {
      if (sensitiveSite) {
        showBadge("Auto disabled on sensitive sites");
        return;
      }
      // cycle: inherit(null) → on → off → inherit
      let next = null;
      if (siteAutoOverride == null) next = true;
      else if (siteAutoOverride === true) next = false;
      else next = null;
      await setSiteAutoOverride(next);
      syncPanelControls();
      const label =
        next === true ? "Site auto: ON" : next === false ? "Site auto: OFF" : "Site auto: inherit";
      showBadge(label);
      pushActionState();
      if (autoMode && !translated && phase === "idle" && pageLooksGerman()) {
        runToggle();
      }
    });
    siteAutoRow.append(siteAutoLabel, siteAutoSwitchEl);

    hideBtnEl = document.createElement("button");
    hideBtnEl.type = "button";
    hideBtnEl.id = "__de_en_hide_site";
    hideBtnEl.textContent = "Hide on this site";
    hideBtnEl.addEventListener("click", async () => {
      if (hiddenOnSite) {
        await setHiddenOnThisSite(false);
        showBadge("Panel shown on this site");
      } else {
        await setHiddenOnThisSite(true);
        showBadge("Hidden on this site");
      }
      syncPanelControls();
      applyPanelVisibility();
    });

    body.append(
      sensitiveNote,
      fabEl,
      divider,
      autoRow,
      siteAutoRow,
      hideBtnEl
    );

    panelEl.append(privacyEl, header, pill, body);
    root.append(unhideBtnEl, panelEl);
    shadowRoot.appendChild(root);
    document.documentElement.appendChild(hostEl);

    panelEl.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") {
        await setMinimized(true);
        applyPanelVisibility();
      }
    });
  }

  // ---------- messaging ----------

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === "DE_EN_PING") {
      sendResponse({
        ok: true,
        translated,
        autoMode,
        phase,
        sensitive: sensitiveSite,
      });
      return false;
    }
    if (msg.type === "DE_EN_TOGGLE") {
      runToggleLocal().then(() =>
        sendResponse({ ok: true, translated, phase })
      );
      return true;
    }
    if (msg.type === "DE_EN_SHOW_PANEL") {
      if (IS_TOP) {
        setHiddenOnThisSite(false).then(() => {
          setMinimized(false).then(() => {
            applyPanelVisibility();
            syncPanelControls();
          });
        });
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  window.__deEnCleanup = () => {
    try {
      runGeneration++;
      phase = "idle";
      stopObserver();
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      try {
        chrome.storage.onChanged.removeListener(onStorageChanged);
      } catch {
        /* ignore */
      }
      if (hostEl) hostEl.remove();
      hostEl = null;
      shadowRoot = null;
      panelEl = null;
    } catch {
      /* ignore */
    }
  };

  // ---------- init ----------

  async function init() {
    if (IS_TOP) await createPanel();
    await loadPrefs();

    // E2: soft-minimize non-German only in memory for this load if no site pref
    const german = pageLooksGerman();
    try {
      const stored = await chrome.storage.local.get("deEnSitePrefs");
      const site = ((stored.deEnSitePrefs || {})[hostname()] || {});
      if (site.minimized == null && IS_TOP && !german && !autoMode) {
        panelMinimized = true;
      }
    } catch {
      if (IS_TOP && !german && !autoMode) panelMinimized = true;
    }

    if (IS_TOP) {
      syncPanelControls();
      applyPanelVisibility();
      if (!privacyAccepted) showPrivacyPrompt(true);
    }
    pushActionState();

    // F2: never auto on sensitive
    if (autoMode && !translated && german && !sensitiveSite) {
      if (privacyAccepted) await translatePage();
      else if (IS_TOP) showBadge("Accept privacy to auto-translate");
    } else if (IS_TOP && autoMode && !german) {
      showBadge("Auto on — page may not be German");
    } else if (IS_TOP && sensitiveSite && globalAutoMode) {
      showBadge("Sensitive site — auto blocked");
    }
  }

  if (document.documentElement) init();
  else document.addEventListener("DOMContentLoaded", init, { once: true });
})();
