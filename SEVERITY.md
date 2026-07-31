# Severity master list status (section O)

Snapshot of the original audit priorities and current status as of **v1.7**.

## P0 — must be solid for daily use

| Item | Status |
|------|--------|
| In-flight apply after restore/cancel | **Fixed** (runGeneration) |
| Extension reload bricks tab | **Mitigated** (cleanup + reload banner) |
| Cancel leaves half-translated | **Fixed** (cancel → restore) |
| Privacy: auto on sensitive pages | **Fixed** (sensitive host list + consent) |
| Attr truncate corrupted originals | **Fixed** (fullOriginal) |

## P1 — real-site quality

| Item | Status |
|------|--------|
| Shadow DOM / iframes | **Fixed** (open shadow + all_frames + broadcast) |
| Global rate limit | **Fixed** (SW queue) |
| Forced DE on English strings | **Mitigated** (English skip heuristics) |
| SPA observer thrash | **Mitigated** (debounce + gap + tab hidden) |
| Unpack dumps on first node | **Fixed** (throw + per-item fallback) |
| Main-thread DOM jank | **Mitigated** (yielding walk) |
| Silent toolbar failure | **Fixed** (badge × + toast) |
| Hide site no unhide | **Fixed** (unhide chip) |
| Large-node mid-word split | **Fixed** (boundary split) |

## P2 / P3

| Item | Status |
|------|--------|
| Error badge wiped | **Fixed** |
| 403 retry | **Fixed** |
| Cache | **Fixed** |
| Per-site minimize / auto | **Fixed** |
| Lang detection confidence | **Fixed** |
| A11y / drag / theme | **Fixed** |
| Architecture / unit tests | **Fixed in v1.6** (shared/* + tests) |
| Official API / Store distribution | **Out of scope** (personal use) |

## Remaining known limits (won’t fully close without redesign)

- Closed page shadow roots
- Unofficial Google endpoint ToS / rate limits
- Framework node identity after full remount
- No multi-language pairs beyond DE→EN
