import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareVersions, updateCheckDisabled, upgradeMessage } from "../src/update.js";

describe("compareVersions", () => {
  it("orders versions as semver does", () => {
    const ordered = ["0.1.0", "0.2.0-alpha", "0.2.0-beta.2", "0.2.0-beta.10", "0.2.0-rc.1", "0.2.0", "0.2.1", "0.10.0", "1.0.0"];
    for (let i = 0; i + 1 < ordered.length; i++) {
      const [lower = "", higher = ""] = [ordered[i], ordered[i + 1]];
      assert.ok(compareVersions(lower, higher) < 0, `${lower} < ${higher}`);
      assert.ok(compareVersions(higher, lower) > 0, `${higher} > ${lower}`);
    }
  });

  it("ignores a leading v and build metadata", () => {
    assert.equal(compareVersions("v1.2.3", "1.2.3+build.5"), 0);
  });
});

describe("upgradeMessage", () => {
  it("asks for an upgrade only to a newer stable version", () => {
    assert.match(upgradeMessage("interref", "0.1.0", "0.2.0") ?? "", /interref 0\.2\.0 is available\. You have 0\.1\.0/u);
    assert.match(upgradeMessage("iref", "0.2.0-beta.3", "0.2.0") ?? "", /npm install --global @normal-computing\/interref/u);
    assert.equal(upgradeMessage("interref", "0.2.0", "0.2.0"), undefined);
    assert.equal(upgradeMessage("interref", "0.3.0-beta.1", "0.2.0"), undefined);
    assert.equal(upgradeMessage("interref", "0.1.0", "0.2.0-beta.3"), undefined);
    assert.equal(upgradeMessage("interref", "0.1.0", undefined), undefined);
  });
});

describe("updateCheckDisabled", () => {
  it("obeys INTERREF_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER and CI", () => {
    assert.equal(updateCheckDisabled({}), false);
    assert.equal(updateCheckDisabled({ INTERREF_NO_UPDATE_CHECK: "1" }), true);
    assert.equal(updateCheckDisabled({ INTERREF_NO_UPDATE_CHECK: "0" }), false);
    assert.equal(updateCheckDisabled({ NO_UPDATE_NOTIFIER: "1" }), true);
    assert.equal(updateCheckDisabled({ CI: "true" }), true);
  });
});
