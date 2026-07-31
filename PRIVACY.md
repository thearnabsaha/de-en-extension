# Privacy Policy — DE → EN Page Translator

**Last updated:** 2026-07-31

## What this extension does

When you translate a page (manually or via auto-translate), the extension collects visible text and selected attributes from the current tab and sends that text to **Google’s public Translate endpoint** (`translate.googleapis.com`) to obtain an English translation. Translated text is written back into the page DOM.

## Data sent

- Visible text nodes and attributes (`title`, `alt`, `aria-label`, `placeholder`, `aria-description`) from pages you choose to translate.
- No browsing history, cookies, passwords, or form field values from `<input>` / `<textarea>` are intentionally collected (those elements are skipped).

## Data not collected

- We do not operate our own servers.
- We do not run analytics, ads, or account systems.
- Preferences are stored only in Chrome’s local extension storage on your device (`chrome.storage.local`).

## Sensitive sites

Auto-translate is **disabled** on hosts that match a built-in sensitive list (mail, banking-ish patterns, localhost, private IP ranges, etc.). Manual translation remains possible after you accept the privacy notice—use judgment.

## Third parties

Google processes translation requests under Google’s own terms and policies. This extension uses an unofficial public endpoint suitable for personal use; it is not the billed Cloud Translation API.

## Your controls

- Privacy consent is required before the first translation (stored as `deEnPrivacyAccepted`).
- Global and per-site auto-translate toggles.
- Hide panel on a site.
- Cancel/restore undoes in-page text changes tracked by the extension.

## Contact

This is a personal open-source project. Prefer filing issues on the GitHub repository if you publish one.
