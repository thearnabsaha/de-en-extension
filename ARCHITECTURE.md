# Architecture (section N)

## Layout

```
de-en-extension/
  manifest.json          # MV3
  background.js          # service worker: rate-limit, cache, fetch, broadcast
  content.js             # DOM, UI, observer, state machine
  content.css            # panel styles (loaded into closed shadow)
  shared/
    protocol.js          # message types + version
    markers.js           # pure pack/unpack (unit-tested)
    lang.js              # pure language score + PII soft-redact
    storage-keys.js      # chrome.storage key names
  tests/                 # node --test
  icons/
```

## Data flow

1. User toggles (panel / toolbar / Alt+Shift+B).
2. SW broadcasts `DE_EN_TOGGLE` to all frames (`webNavigation.getAllFrames`).
3. Each content script collects text/attrs (light DOM + open shadow), chunks them.
4. Translate path: optional on-device `Translator` API → else SW `DE_EN_TRANSLATE(_BATCH)`.
5. SW rate-limits GETs to `translate.googleapis.com`, caches results, returns text.
6. Content applies generation-guarded writes; MutationObserver quietly re-translates new nodes.

## Message protocol

All messages should use `DeEn.msg(type, payload)` and include `v: PROTOCOL_VERSION`.

| Type | Direction | Purpose |
|------|-----------|---------|
| `DE_EN_PING` | SW → content | Handshake / alive |
| `DE_EN_TOGGLE` | SW → content | Local toggle |
| `DE_EN_BROADCAST_TOGGLE` | content → SW | Fan-out toggle |
| `DE_EN_TRANSLATE` | content → SW | One string |
| `DE_EN_TRANSLATE_BATCH` | content → SW | Many strings |
| `DE_EN_ACTION_STATE` | content → SW | Toolbar badge |
| `DE_EN_SHOW_PANEL` | any → content | Unhide panel |
| `DE_EN_TOOLBAR_FAIL` | SW → content | Restricted page feedback |

Bump `DeEn.PROTOCOL_VERSION` when shapes break.

## Storage keys

See `shared/storage-keys.js` (`DeEn.StorageKeys`).

## Tests

```bash
npm test
# or: node --test tests/*.test.js
```

## Canonical path

Prefer **one** install directory (e.g. Desktop `grok things/de-en-extension`).  
Do not load both Desktop and Downloads copies in Chrome.
