#!/usr/bin/env node
/**
 * R: smoke-check that the five priority fixes still appear in source.
 * Exit 1 if any required pattern is missing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const background = fs.readFileSync(path.join(root, "background.js"), "utf8");

const checks = [
  {
    id: 1,
    name: "Generation-guarded state machine",
    ok: /runGeneration/.test(content) && /isGenCurrent/.test(content) && /phase === "restoring"/.test(content),
  },
  {
    id: 2,
    name: "Extension reload cleanup / banner",
    ok: /__deEnCleanup/.test(content) && /__de_en_reload_banner|showReloadBanner/.test(content),
  },
  {
    id: 3,
    name: "Global SW rate limiter",
    ok: /MAX_CONCURRENT_FETCHES/.test(background) && /acquireSlot|waitQueue/.test(background),
  },
  {
    id: 4,
    name: "fullOriginal for attributes / text",
    ok: /fullOriginal/.test(content),
  },
  {
    id: 5,
    name: "Privacy consent + sensitive hosts",
    ok:
      /deEnPrivacyAccepted|PRIVACY_ACCEPTED/.test(content) &&
      /SENSITIVE_HOST|isSensitiveHost/.test(content + background),
  },
];

let failed = 0;
for (const c of checks) {
  const mark = c.ok ? "OK " : "FAIL";
  console.log(`${mark}  R${c.id}: ${c.name}`);
  if (!c.ok) failed++;
}

// Bonus P caps
const caps =
  /MAX_CHUNKS_PER_RUN/.test(content) && /MAX_ITEMS_PER_RUN/.test(content);
console.log(`${caps ? "OK " : "FAIL"}  P: huge-page caps`);
if (!caps) failed++;

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll five priority fixes + huge-page caps present.");
