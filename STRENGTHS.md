# What is solid (section Q)

Honest inventory of strengths in the current design — keep these when refactoring.

## Architecture

- **MV3 shape is correct**: network in the service worker, DOM in content scripts.
- **Generation-guarded applies** make cancel/restore safe under concurrency.
- **Shared pure modules** (`shared/markers`, `shared/lang`, `shared/protocol`) are unit-tested without a browser.
- **Versioned messages** (`v` + `DeEn.Msg`) reduce silent SW/content drift after upgrades.

## Reliability

- Global **rate limit + cache + retries** (including 403/429) in one place (SW).
- **Marker remap** either succeeds or falls back per-item — no “dump all English on node 0”.
- **fullOriginal** for attributes avoids truncation data loss.
- **Huge-page caps** trade completeness for not melting the free endpoint.

## Product / UX

- Dual controls: glass panel + toolbar + **Alt+Shift+B**.
- **Per-site** minimize / hide / auto / language override / position.
- **Privacy consent** and **sensitive-site auto-block** before quiet bulk exfil.
- Closed-shadow panel reduces page CSS/JS interference.

## Coverage

- Open **shadow roots**, **all frames**, selected **attributes**, SPA **MutationObserver**.
- Skips code/inputs/contenteditable/notranslate by design (see NON_BUGS.md).

## What “solid” does *not* mean

- Not Store-ready (unofficial translate endpoint).
- Not perfect SPA restore after full remount.
- Not multi-language (strict DE→EN).
- Closed shadow DOM on host pages remains opaque.

When changing code, prefer preserving these properties over micro-optimizations that break them.
