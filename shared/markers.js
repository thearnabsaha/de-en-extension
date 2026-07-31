/**
 * Pure marker pack/unpack (L + N testable).
 * No DOM / chrome APIs.
 */
(function (g) {
  const DeEn = g.DeEn || (g.DeEn = {});

  const MARKER_TOKEN = "\uE000DEEN\uE001";

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
    return String(text)
      .replace(/\uE000DEEN\uE001/g, "\uE002DEEN\uE002")
      .replace(/\u2060⟦DEEN:\d+⟧\u2060/g, (m) => m.replace(/DEEN/g, "D·E·N"));
  }

  function makeMarker(packId, index) {
    const body = packId + ":" + index;
    const sum = hashStr(body).slice(0, 4);
    return MARKER_TOKEN + body + ":" + sum + MARKER_TOKEN;
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
   * @param {string} translatedFull
   * @param {number} count
   * @param {string} packId
   * @returns {string[]}
   */
  function unpackValues(translatedFull, count, packId) {
    if (count === 1) return [translatedFull == null ? "" : translatedFull];
    if (!packId) throw new Error("Marker remap failed: missing pack id");
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      esc(MARKER_TOKEN) + esc(packId) + ":(\\d+):([a-z0-9]+)" + esc(MARKER_TOKEN),
      "g"
    );
    const parts = [];
    let last = 0;
    let m;
    const src = translatedFull || "";
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
    return String(seq) + "x" + hashStr(String(Date.now()) + Math.random()).slice(0, 6);
  }

  DeEn.markers = {
    MARKER_TOKEN: MARKER_TOKEN,
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
