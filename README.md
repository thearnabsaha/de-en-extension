# DE → EN Page Translator (Chrome Extension)

Toggle-translate any webpage from **German to English**, in place. Free — no API key (Google public translate endpoint via the extension service worker).

**v1.4** — performance (yielding DOM walks, capped maps), language confidence + per-site override, draggable/themed panel, progress bar, toolbar failure feedback, Alt+Shift+T.

## Install (unpacked)

1. Clone or download this folder and keep it somewhere permanent.
2. Chrome → `chrome://extensions` → **Developer mode**.
3. **Load unpacked** → select this directory.
4. Pin the extension. **Reload** the extension and **refresh tabs** after updates.

## Use

| Control | Action |
|--------|--------|
| **DE/EN switch** | Translate ↔ restore. Mid-run click **cancels and restores**. |
| **Alt+Shift+T** | Toggle translation (also works from toolbar). |
| **Auto (global)** | Translate high-confidence German pages automatically. |
| **Auto on this site** | Cycle: inherit → on → off (red = force off). |
| **Page language** | Auto / Force DE / Force EN (per site). |
| **Theme** | Auto / Dark / Light. |
| **Drag handle (⠿)** | Reposition panel (saved per site). |
| **Hide / Show** | Hide panel; **DE/EN** chip re-shows it. |
| **Privacy notice** | Required once before any network translate. |
| **Toolbar badge** | `EN` translated · `A` auto · `P` sensitive · `!` error · `×` cannot inject |

## What is translated

- Light DOM + **open shadow roots** (all frames)
- Attributes: `title`, `alt`, `aria-label`, `placeholder`, `aria-description`
- Dynamic content via rate-limited `MutationObserver`

Skipped: code/inputs/svg/math/contenteditable, `.notranslate`, URLs/emails, likely-English strings, already-translated fingerprints.

## v1.4 highlights (G / H / I)

- **G** — Yielding DOM collection, single compiled marker regex, capped tracking maps, toasts always auto-hide  
- **H** — Confidence-scored language detection; auto only when confident; per-site Force DE/EN  
- **I** — Draggable panel, light/dark theme, progress bar, Expand + Translate when minimized, toolbar failure messages, extension-reload toast, keyboard shortcut  

See [PRIVACY.md](./PRIVACY.md).

## Limitations

- Closed shadow roots on the **page** cannot be read.
- Unofficial Google endpoint may rate-limit; personal use only.
- Restricted pages (`chrome://`, etc.) cannot be scripted.

## Storage keys

| Key | Meaning |
|-----|---------|
| `deEnAutoMode` | Global auto |
| `deEnPrivacyAccepted` | Privacy consent |
| `deEnTheme` | `auto` \| `dark` \| `light` |
| `deEnSitePrefs` | `{ [host]: { minimized, hidden, auto, lang, pos } }` |
| `deEnHiddenHosts` | Flat hidden-host list |

## License

MIT — see [LICENSE](./LICENSE).
