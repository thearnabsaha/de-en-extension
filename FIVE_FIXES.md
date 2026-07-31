# The five priority fixes (section R)

Original “if you only fix five things” list — status as of **v1.7**.

| # | Fix | Status | Where |
|---|-----|--------|--------|
| 1 | **State machine** with run generation IDs; never apply stale results; cancel = abort + restore | **Done** | `runGeneration`, `phase`, `translatePage` / `restorePage` / `applyItemTranslation` in `content.js` |
| 2 | **Extension-reload guard** so dead tabs recover | **Done** | `__deEnCleanup`, re-inject shared+content scripts, reload **banner** + toast |
| 3 | **Global rate limiter** in the SW (all tabs share) | **Done** | `acquireSlot` / `MAX_CONCURRENT_FETCHES` / `MIN_GAP_MS` in `background.js` |
| 4 | **Never store truncated attrs as originals** | **Done** | `fullOriginal` on work items; large-attr sequential path |
| 5 | **Sensitive-host denylist + privacy confirm** | **Done** | privacy gate `deEnPrivacyAccepted`; expanded sensitive host regexes; auto forced off |

## Smoke verification

```bash
npm test
npm run verify-five   # pattern checks that the five guards still exist in source
```

## Still intentional (not in the five)

- Unofficial Google endpoint (product choice for free personal use).
- Closed host shadow roots (platform).
- DE→EN only (scope).
