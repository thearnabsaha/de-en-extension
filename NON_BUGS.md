# Intentional behavior (not bugs) — section M

These are deliberate product or platform choices. Do not “fix” them without a design change.

| Observation | Why it’s intentional |
|-------------|----------------------|
| `<input>` / `<textarea>` values are not translated | Avoid rewriting user form data while typing |
| Closed shadow roots on host pages are unread | Browser platform limit; open shadow is walked |
| `chrome://`, Web Store, PDF viewer pages fail | Chrome blocks extension content scripts |
| Strict `sl=de` → `tl=en` only | Product scope: German → English, not a general translator |
| Unofficial Google `client=gtx` endpoint | Personal free use; not Cloud Translation API |
| Auto-translate skipped on sensitive hosts | Privacy guard (mail, bank patterns, localhost, private IPs) |
| Panel only in top frame | Avoid N floating panels inside iframes; frames still translate |
| Manual translate still allowed on sensitive sites | After privacy consent; auto is what we hard-block |
| SPA re-renders may need re-translate | Node identity tracking cannot restore destroyed nodes |
| Numbers/locales may reformat (1.234,56 → 1,234.56) | Machine translation side effect, not our post-processor |
| Extension must be reloaded after code changes | Normal unpacked MV3 workflow |
| Two local folders (Desktop + Downloads) may drift | Keep one canonical path; see ARCHITECTURE.md |

If a future version expands language pairs or uses an official API, update this file.
