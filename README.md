# DE → EN Page Translator (Chrome Extension)

Toggle-translate any webpage from **German to English**, in place. Free — no API key (Google public translate endpoint via the extension service worker).

**v1.8** — E2E scenario hardening (huge-page caps, clearer progress/errors), documented strengths + five priority fixes, `npm run verify`.

## Install (unpacked)

1. Clone or download this folder and keep it somewhere permanent.
2. Chrome → `chrome://extensions` → **Developer mode**.
3. **Load unpacked** → select this directory.
4. Pin the extension. **Reload** the extension and **refresh tabs** after updates.

## Use

| Control | Action |
|--------|--------|
| **DE/EN switch** | Translate ↔ restore. Mid-run click **cancels and restores**. |
| **Alt+Shift+B** | Toggle translation (also works from toolbar). |
| **Auto (global)** | Translate high-confidence German pages automatically. |
| **Auto on this site** | Cycle: inherit → on → off (red = force off). |
| **Page language** | Auto / Force DE / Force EN (per site). |
| **Theme** | Auto / Dark / Light. |
| **Drag handle (⠿)** | Reposition panel (saved per site). |
| **Hide / Show** | Hide panel; **DE/EN** chip re-shows it. |
| **Turn off extension** | Fully disables the extension (re-enable at `chrome://extensions`). |
| **Privacy notice** | Required once before any network translate. |
| **Toolbar badge** | `EN` translated · `A` auto · `P` sensitive · `!` error · `×` cannot inject |

## What is translated

- Light DOM + **open shadow roots** (all frames)
- Attributes: `title`, `alt`, `aria-label`, `placeholder`, `aria-description`
- Dynamic content via rate-limited `MutationObserver`

Skipped: code/inputs/svg/math/contenteditable, `.notranslate`, URLs/emails, likely-English strings, already-translated fingerprints.

## Docs

| Doc | Topic |
|-----|--------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Layout, data flow, protocol |
| [NON_BUGS.md](./NON_BUGS.md) | Intentional limits (M) |
| [SEVERITY.md](./SEVERITY.md) | Audit status (O) |
| [E2E_SCENARIOS.md](./E2E_SCENARIOS.md) | Failure scenarios (P) |
| [STRENGTHS.md](./STRENGTHS.md) | What is solid (Q) |
| [FIVE_FIXES.md](./FIVE_FIXES.md) | Priority five (R) |
| [PRIVACY.md](./PRIVACY.md) | Privacy policy |

## Develop

```bash
npm test           # unit tests
npm run check      # syntax check
npm run verify-five  # R1–R5 still in source
npm run verify     # check + test + verify-five
```

Load **one** unpacked path only (avoid Desktop + Downloads duplicates).

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
