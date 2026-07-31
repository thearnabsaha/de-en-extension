/**
 * Node unit tests for shared/lang.js (N).
 * Run: node --test tests/lang.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const lang = require(path.join(__dirname, "..", "shared", "lang.js"));

describe("scoreGermanText", () => {
  it("scores clear German as German with decent confidence", () => {
    const text =
      "Der schnelle braune Fuchs springt über den faulen Hund und ist nicht müde. " +
      "Wir haben heute Morgen Kaffee getrunken und können später spazieren gehen.";
    const r = lang.scoreGermanText(text);
    assert.equal(r.isGerman, true);
    assert.ok(r.confidence >= 0.42);
    assert.ok(r.deHits >= 3);
  });

  it("scores clear English as not German", () => {
    const text =
      "The quick brown fox jumps over the lazy dog and will not stop. " +
      "Please click login to continue with your account settings and privacy cookie accept.";
    const r = lang.scoreGermanText(text);
    assert.equal(r.isGerman, false);
  });

  it("returns low confidence for tiny samples", () => {
    const r = lang.scoreGermanText("Hi");
    assert.equal(r.isGerman, false);
    assert.equal(r.confidence, 0);
  });
});

describe("softRedactPII", () => {
  it("redacts emails and phones", () => {
    const out = lang.softRedactPII("Mail me at user@example.com or +49 170 1234567 thanks");
    assert.ok(out.includes("[email]"));
    assert.ok(out.includes("[phone]"));
    assert.ok(!out.includes("user@example.com"));
  });
});
