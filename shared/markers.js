/**
 * Pack/unpack multiple strings into one translate request.
 * Uses ASCII-ish separators Google usually preserves (not private-use chars).
 */
(function (g) {
  const DeEn = g.DeEn || (g.DeEn = {});

  // Unique, mostly-preserved delimiter. Avoid private-use (Google often strips those).
  const OPEN = "<<<DEEN:";
  const CLOSE = ">>>";

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function sanitizeForPack(text) {
    if (!text) return text;
    // Neutralize accidental delimiter lookalikes in source
    return String(text)
      .replace(/<<<DEEN:/gi, "<<‹DEEN:")
      .replace(/>>>/g, "»»>");
  }

  function makeMarker(packId, index) {
    return OPEN + packId + ":" + index + CLOSE;
  }

  /**
   * @param {string[]} values
   * @param {string} packId
   * @returns {string}
   */
  function packValues(values, packId) {
    if (!values.length) return "";
    if (values.length === 1) return sanitizeForPack(values[0]);
    let out = sanitizeForPack(values[0]);
    for (let i = 0; i < values.length - 1; i++) {
      out += makeMarker(packId, i) + sanitizeForPack(values[i + 1]);
    }
    return out;
  }

  /**
   * Lenient unpack — tolerates spaces Google inserts around markers.
   * @param {string} translatedFull
   * @param {number} count
   * @param {string} packId
   * @returns {string[]}
   */
  function unpackValues(translatedFull, count, packId) {
    if (count === 1) return [translatedFull == null ? "" : translatedFull];
    if (!packId) throw new Error("Marker remap failed: missing pack id");
    const src = translatedFull == null ? "" : String(translatedFull);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Allow optional spaces around marker tokens
    const re = new RegExp(
      "\\s*" + esc(OPEN) + "\\s*" + esc(packId) + "\\s*:\\s*(\\d+)\\s*" + esc(CLOSE) + "\\s*",
      "gi"
    );
    const parts = [];
    let last = 0;
    let m;
    let expectedIdx = 0;
    while ((m = re.exec(src)) !== null) {
      parts.push(src.slice(last, m.index));
      const idx = parseInt(m[1], 10);
      if (idx !== expectedIdx) {
        throw new Error("Marker remap failed: index gap at " + expectedIdx);
      }
      expectedIdx++;
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

  function newPackId(seq) {
    return String(seq) + "x" + hashStr(String(Date.now()) + Math.random()).slice(0, 5);
  }

  DeEn.markers = {
    MARKER_TOKEN: OPEN,
    hashStr: hashStr,
    sanitizeForPack: sanitizeForPack,
    makeMarker: makeMarker,
    packValues: packValues,
    unpackValues: unpackValues,
    newPackId: newPackId,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = DeEn.markers;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
