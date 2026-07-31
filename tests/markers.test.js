/**
 * Node unit tests for shared/markers.js (N).
 * Run: node --test tests/markers.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Load shared modules into globalThis
require(path.join(__dirname, "..", "shared", "protocol.js"));
const markers = require(path.join(__dirname, "..", "shared", "markers.js"));

describe("markers.packValues / unpackValues", () => {
  it("round-trips a single value without markers", () => {
    const packed = markers.packValues(["Hallo Welt"], "p1");
    assert.equal(packed, "Hallo Welt");
    const parts = markers.unpackValues("Hello world", 1, "p1");
    assert.deepEqual(parts, ["Hello world"]);
  });

  it("round-trips multiple values with markers intact", () => {
    const packId = "abc1";
    const values = ["Hallo", "Welt", "Wie geht's?"];
    const packed = markers.packValues(values, packId);
    // Simulate translation that keeps markers
    const fakeTranslated =
      "Hello" +
      markers.makeMarker(packId, 0) +
      "World" +
      markers.makeMarker(packId, 1) +
      "How are you?";
    const parts = markers.unpackValues(fakeTranslated, 3, packId);
    assert.equal(parts.length, 3);
    assert.equal(parts[0], "Hello");
    assert.equal(parts[1], "World");
    assert.equal(parts[2], "How are you?");
  });

  it("throws on missing pack id for multi-part", () => {
    assert.throws(() => markers.unpackValues("a|b", 2, ""), /missing pack id/);
  });

  it("throws on part count mismatch", () => {
    const packId = "z9";
    const packed = markers.packValues(["one", "two", "three"], packId);
    // Drop last marker artificially
    const broken = "ONE" + markers.makeMarker(packId, 0) + "TWO";
    assert.throws(() => markers.unpackValues(broken, 3, packId), /expected 3/);
  });

  it("sanitizes private-use token in source", () => {
    const nasty = "x\uE000DEEN\uE001y";
    const s = markers.sanitizeForPack(nasty);
    assert.ok(!s.includes("\uE000DEEN\uE001"));
  });

  it("newPackId is unique-ish", () => {
    const a = markers.newPackId(1);
    const b = markers.newPackId(2);
    assert.notEqual(a, b);
  });
});
