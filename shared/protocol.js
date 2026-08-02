/**
 * Shared message protocol (N).
 * Loaded by service worker (importScripts) and content scripts (manifest order).
 * Bump PROTOCOL_VERSION when message shapes break compatibility.
 */
(function (g) {
  const DeEn = g.DeEn || (g.DeEn = {});

  DeEn.PROTOCOL_VERSION = 1;

  /** @enum {string} */
  DeEn.Msg = Object.freeze({
    PING: "DE_EN_PING",
    TOGGLE: "DE_EN_TOGGLE",
    TRANSLATE: "DE_EN_TRANSLATE",
    TRANSLATE_BATCH: "DE_EN_TRANSLATE_BATCH",
    BROADCAST_TOGGLE: "DE_EN_BROADCAST_TOGGLE",
    ACTION_STATE: "DE_EN_ACTION_STATE",
    CHECK_SENSITIVE: "DE_EN_CHECK_SENSITIVE",
    SHOW_PANEL: "DE_EN_SHOW_PANEL",
    TOOLBAR_FAIL: "DE_EN_TOOLBAR_FAIL",
    /** Fully disable the extension; user re-enables at chrome://extensions */
    DISABLE_SELF: "DE_EN_DISABLE_SELF",
  });

  /**
   * Wrap an outbound message with protocol version.
   * @param {string} type
   * @param {object} [payload]
   */
  DeEn.msg = function msg(type, payload) {
    return Object.assign({ v: DeEn.PROTOCOL_VERSION, type: type }, payload || {});
  };

  /**
   * Validate inbound message version. Returns false if incompatible.
   * @param {any} m
   */
  DeEn.checkMsg = function checkMsg(m) {
    if (!m || typeof m !== "object" || !m.type) return false;
    // Allow missing v for one release (forward-compat during upgrade)
    if (m.v == null) return true;
    return Number(m.v) === DeEn.PROTOCOL_VERSION;
  };

  // Node / tests
  if (typeof module !== "undefined" && module.exports) {
    module.exports = DeEn;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
