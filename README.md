# DE → EN Page Translator (Chrome Extension)

Toggle-translate any webpage from **German to English**, in place. Free — no API key (Google public translate endpoint via the extension service worker).

**v1.3** — SPA observer hardening, per-site prefs, multi-tab storage sync, privacy consent, sensitive-site auto block, closed-shadow panel, message validation.

## Install (unpacked)

1. Clone or download this folder and keep it somewhere permanent.
2. Chrome → `chrome://extensions` → **Developer mode**.
3. **Load unpacked** → select this directory.
4. Pin the extension. **Reload** the extension and **refresh tabs** after updates.

## Use

| Control | Action |
|--------|--------|
| **DE/EN switch** | Translate ↔ restore. Mid-run click **cancels and restores**. |
| **Auto (global)** | Translate German-looking pages automatically. |
| **Auto on this site** | Cycle: inherit → on → off (red = force off). |
| **Hide / Show on this site** | Hide panel; small **DE/EN** chip re-shows it. |
| **Privacy notice** | Required once before any network translate. |
| **Toolbar icon** | Toggle all frames; badge `EN` / `A` / `P` (privacy-sensitive) / `!`. |

## What is translated

- Light DOM + **open shadow roots**
- **All frames** (panel only in top frame)
- Attributes: `title`, `alt`, `aria-label`, `placeholder`, `aria-description`
- Dynamic content via rate-limited `MutationObserver` (childList, attributes, **characterData**)

Skipped: code/inputs/svg/math/contenteditable, `.notranslate`, URLs/emails, likely-English strings, already-translated fingerprints.

## Reliability & privacy (v1.3)

- Generation-guarded applies (no restore races)
- Global SW rate limit + cache + 403/429 retries
- Per-site minimize / hide / auto override
- `chrome.storage.onChanged` multi-tab UI sync
- Default denylist always merged (Web Store hosts)
- Sensitive hosts: **auto-translate blocked**
- Closed shadow panel (page JS cannot reach UI)
- Payload size limits + response shape checks in SW

See [PRIVACY.md](./PRIVACY.md).

## Limitations

- Closed shadow roots on the **page** cannot be read (platform).
- Unofficial Google endpoint may rate-limit; personal use only.
- SPA re-renders: restore only tracks current session nodes.
- Restricted pages (`chrome://`, etc.) cannot be scripted.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 v1.3.0 |
| `background.js` | Translate queue, cache, broadcast, validation |
| `content.js` | DOM, observer, prefs, privacy, closed-shadow UI |
| `content.css` | Panel styles (loaded into shadow) |
| `PRIVACY.md` | Privacy policy |
| `icons/` | Toolbar icons |

## Storage keys

| Key | Meaning |
|-----|---------|
| `deEnAutoMode` | Global auto boolean |
| `deEnPrivacyAccepted` | User accepted privacy notice |
| `deEnSitePrefs` | `{ [hostname]: { minimized, hidden, auto } }` |
| `deEnHiddenHosts` | Flat list of hidden hosts (unioned with defaults) |

## License

MIT — see [LICENSE](./LICENSE).
