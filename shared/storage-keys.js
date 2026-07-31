/**
 * chrome.storage.local key catalog (N — single source of truth).
 */
(function (g) {
  const DeEn = g.DeEn || (g.DeEn = {});

  DeEn.StorageKeys = Object.freeze({
    /** @type {boolean} global auto-translate */
    AUTO_MODE: "deEnAutoMode",
    /** @type {boolean} user accepted privacy notice */
    PRIVACY_ACCEPTED: "deEnPrivacyAccepted",
    /** @type {'auto'|'dark'|'light'} */
    THEME: "deEnTheme",
    /**
     * @type {Record<string, {
     *   minimized?: boolean,
     *   hidden?: boolean,
     *   auto?: boolean|null,
     *   lang?: 'de'|'en'|null,
     *   pos?: { top: number, left: number }
     * }>}
     */
    SITE_PREFS: "deEnSitePrefs",
    /** @type {string[]} flat hidden hostnames (unioned with defaults) */
    HIDDEN_HOSTS: "deEnHiddenHosts",
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = DeEn.StorageKeys;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
