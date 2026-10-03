import assert from "node:assert/strict";
import { test } from "node:test";
import { validateGate } from "../src/policy.js";

test("a version 1 gate with approver ids is valid", () => {
  assert.equal(validateGate({ v: 1, approvers: [1, Number.MAX_SAFE_INTEGER] }), null);
});

test("a gate that is not an object is invalid", () => {
  for (const value of [null, undefined, "gate", 1, true, []]) {
    assert.equal(validateGate(value), "invalid gate.json");
  }
});

test("a gate with the wrong keys is invalid", () => {
  assert.equal(validateGate({}), "invalid gate.json");
  assert.equal(validateGate({ v: 1, approvers: [1], extra: true }), "invalid gate.json");
  assert.equal(validateGate({ v: 1, users: [1] }), "invalid gate.json");
  assert.equal(validateGate({ approvers: [1], extra: false }), "invalid gate.json");
});

test("a gate with the wrong version is invalid", () => {
  assert.equal(validateGate({ v: 2, approvers: [1] }), "invalid gate.json");
  assert.equal(validateGate({ v: "1", approvers: [1] }), "invalid gate.json");
});

test("a gate with a bad approver list is invalid", () => {
  assert.equal(validateGate({ v: 1, approvers: [] }), "invalid gate.json");
  assert.equal(validateGate({ v: 1, approvers: null }), "invalid gate.json");
  assert.equal(validateGate({ v: 1, approvers: "1" }), "invalid gate.json");
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", true, null]) {
    assert.equal(validateGate({ v: 1, approvers: [1, id] }), "invalid gate.json");
  }
});
