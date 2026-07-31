# End-to-end failure scenarios (section P)

How real users hit pain — and what v1.7 does about it.

| # | User action | Historical failure | Current status |
|---|-------------|-------------------|----------------|
| 1 | Translate huge news site | 429 storms, long freeze | **Mitigated** — yielding DOM walk, `MAX_ITEMS_PER_RUN` / `MAX_CHUNKS_PER_RUN`, progress toast, rate-limited SW |
| 2 | Toggle mid-translate | “Cancel” left half English | **Fixed** — cancel → full restore + generation bump |
| 3 | Restore while requests in flight | Late applies re-English page | **Fixed** — `runGeneration` guards every apply |
| 4 | Reload extension, keep tabs | Dead panel, no listeners | **Mitigated** — cleanup on re-inject + reload banner |
| 5 | Auto-on + Gmail / intranet | Page text → Google | **Mitigated** — sensitive host auto-block + privacy consent + soft PII redaction |
| 6 | Web component app | Little/no text | **Partial** — open shadow walked; closed shadow still impossible |
| 7 | Cookie banner in iframe | Stayed German | **Fixed** — `all_frames` + broadcast toggle |
| 8 | Hide panel by mistake | No way back | **Fixed** — unhide chip + “Show on this site” |
| 9 | English page with German quotes | Auto translated everything | **Mitigated** — confidence threshold + Force EN override |
| 10 | Very long `title` / `aria-label` | Truncate broke restore | **Fixed** — store `fullOriginal`, large-attr path |
| 11 | SPA infinite scroll | Continuous API thrash | **Mitigated** — debounce + min gap + pause when tab hidden |
| 12 | Toolbar on `chrome://` | Silent no-op | **Fixed** — badge `×` + title + toast when possible |

## Manual E2E checklist

1. Load unpacked v1.7 on a German news site → translate → restore → cancel mid-run.  
2. Enable auto → open Gmail → confirm auto blocked (badge `P`).  
3. Minimize / hide / unhide panel; drag and reload page (position/site prefs).  
4. Reload extension without refreshing tab → banner appears.  
5. Toolbar on `chrome://extensions` → badge `×`.  
6. `npm test` green.

## Caps (huge pages)

| Constant | Default | Purpose |
|----------|---------|---------|
| `MAX_ITEMS_PER_RUN` | 2500 | Cap collected strings per pass |
| `MAX_CHUNKS_PER_RUN` | 80 | Cap network batches per pass |

Toggle again (or wait for observer) to continue translating remaining content.
