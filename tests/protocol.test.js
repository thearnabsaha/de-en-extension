/**
 * Node unit tests for shared/protocol.js (N).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const DeEn = require(path.join(__dirname, "..", "shared", "protocol.js"));

describe("protocol", () => {
  it("has a version and message types", () => {
    assert.equal(typeof DeEn.PROTOCOL_VERSION, "number");
    assert.equal(DeEn.Msg.TRANSLATE, "DE_EN_TRANSLATE");
    assert.equal(DeEn.Msg.TOGGLE, "DE_EN_TOGGLE");
    assert.equal(DeEn.Msg.POWER_OFF, "DE_EN_POWER_OFF");
    assert.equal(DeEn.Msg.POWER_ON, "DE_EN_POWER_ON");
    assert.equal(DeEn.Msg.DISABLE_SELF, "DE_EN_POWER_OFF");
  });

  it("msg() wraps type and version", () => {
    const m = DeEn.msg(DeEn.Msg.PING, { ok: true });
    assert.equal(m.v, DeEn.PROTOCOL_VERSION);
    assert.equal(m.type, DeEn.Msg.PING);
    assert.equal(m.ok, true);
  });

  it("checkMsg accepts current version and missing v", () => {
    assert.equal(DeEn.checkMsg({ type: "X" }), true);
    assert.equal(DeEn.checkMsg(DeEn.msg("X")), true);
    assert.equal(DeEn.checkMsg({ type: "X", v: 999 }), false);
    assert.equal(DeEn.checkMsg(null), false);
  });
});
