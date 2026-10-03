import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PINNED_KEYS } from "../src/keys.js";
import { evaluate } from "../src/evaluate.js";
import { render } from "../src/render.js";
import { packSchemaError, verifyPack } from "../src/verify-pack.js";
import {
  baseState,
  makeKeyPair,
  signBytes,
  ticketPack,
  ticketRule,
} from "../helpers/fixture-support.js";

const rule = ticketRule();
const packSchema = JSON.parse(readFileSync(new URL("../schemas/pack.v0.json", import.meta.url), "utf8"));
const cloudPackBytes = readFileSync(new URL("./fixtures/pack/cloud-demo-pack.json", import.meta.url));
const cloudPack = JSON.parse(cloudPackBytes.toString("utf8"));
const ruleIdWithoutPrefix = "X-1";
const longRuleId = `AY-${"A".repeat(64)}`;
const longVersion = `${"1".repeat(61)}.0.0`;

function signed(pack, privateKey, kid = "test-pack-1") {
  const bytes = Buffer.from(typeof pack === "string" ? pack : JSON.stringify(pack));
  const sig = signBytes(bytes, privateKey);
  const sigBytes = Buffer.from(JSON.stringify({ kid, sig }));
  return { bytes, sigBytes };
}

function objectMatches(value, schema) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  if (schema.additionalProperties !== false) return false;
  if (!schema.required.every((key) => Object.hasOwn(value, key))) return false;
  return Object.keys(value).every((key) => Object.hasOwn(schema.properties, key));
}

function stringMatches(value, schema) {
  if (typeof value !== "string") return false;
  const length = Array.from(value).length;
  if (schema.minLength != null && length < schema.minLength) return false;
  if (schema.maxLength != null && length > schema.maxLength) return false;
  return schema.pattern == null || new RegExp(schema.pattern, "u").test(value);
}

function smallSchemaCheck(pack) {
  if (!objectMatches(pack, packSchema)) return false;
  const properties = packSchema.properties;
  if (pack.schema !== properties.schema.const) return false;
  if (!stringMatches(pack.version, properties.version)) return false;
  if (!stringMatches(pack.team, properties.team)) return false;
  const rules = properties.rules;
  if (!Array.isArray(pack.rules) || pack.rules.length < rules.minItems || pack.rules.length > rules.maxItems) {
    return false;
  }
  if (rules.uniqueItems && new Set(pack.rules.map((item) => JSON.stringify(item))).size !== pack.rules.length) {
    return false;
  }
  if (new Set(pack.rules.map((item) => item && item.id)).size !== pack.rules.length) {
    return false;
  }
  return pack.rules.every((item) => {
    const itemSchema = rules.items;
    if (!objectMatches(item, itemSchema)) return false;
    return stringMatches(item.id, itemSchema.properties.id)
      && stringMatches(item.description, itemSchema.properties.description)
      && itemSchema.properties.enforcement.enum.includes(item.enforcement)
      && stringMatches(item.check, itemSchema.properties.check);
  });
}

const schemaFixtures = [
  ["cloud pack", cloudPack, null],
  ["unsupported schema", { ...cloudPack, schema: "apexyard.pack/1" }, "unsupported pack schema"],
  ["unknown top-level field", { ...cloudPack, extra: true }, "invalid pack"],
  ["unknown rule field", ticketPack([{ ...rule, extra: true }]), "invalid pack"],
  ["bad team id", { ...cloudPack, team: "Demo" }, "invalid pack"],
  ["duplicate rule id", ticketPack([rule, { ...rule, description: "A second description." }]), "invalid pack"],
  ["empty rules", ticketPack([]), "invalid pack"],
  ["bad version", { ...cloudPack, version: "01.0.0" }, "invalid pack"],
  ["missing description", ticketPack([{ id: rule.id, enforcement: rule.enforcement, check: rule.check }]), "invalid pack"],
  ["control character in description", ticketPack([{ ...rule, description: "bad\u0007text" }]), "invalid pack"],
  ["description over 280 characters", ticketPack([{ ...rule, description: "x".repeat(281) }]), "invalid pack"],
  ["more than 100 rules", ticketPack(Array.from({ length: 101 }, (_, index) => ({
    ...rule,
    id: `AY-RULE-${String(index).padStart(3, "0")}`,
  }))), "invalid pack"],
  ["rule id without AY- prefix", ticketPack([{ ...rule, id: ruleIdWithoutPrefix }]), "invalid pack"],
  ["67-character rule id", ticketPack([{ ...rule, id: longRuleId }]), "invalid pack"],
  ["65-character version", { ...cloudPack, version: longVersion }, "invalid pack"],
];

test("accepts the cloud producer fixture and evaluates check A", () => {
  const keys = makeKeyPair();
  const sig = signBytes(cloudPackBytes, keys.privateKey);
  const sigBytes = Buffer.from(JSON.stringify({ kid: "apexyard-pack-1", sig }));
  const verified = verifyPack(cloudPackBytes, sigBytes, { "apexyard-pack-1": keys.pem });
  assert.equal(verified.ok, true);
  assert.equal(verified.team, "demo");
  assert.equal(verified.version, "0.1.0");
  assert.deepEqual(verified.pack, cloudPack);

  const state = baseState();
  state.policy.pack = verified;
  const result = evaluate(state.policy, state.pr);
  assert.equal(result.verdict, "pass");
  assert.deepEqual(
    result.reasons.map(({ id, outcome }) => [id, outcome]),
    [["AY-TICKET-001", "pass"], ["approval", "pass"]],
  );
  const packFact = result.evidence.facts.find((fact) => fact.kind === "pack");
  assert.deepEqual(packFact.value, {
    version: "0.1.0",
    team: "demo",
    result: "ok",
    kid: "apexyard-pack-1",
  });
  assert.equal(packFact.label, "verified by signature");
  const summary = render(result.evidence);
  assert.match(summary, /0\.1\.0 demo ok apexyard-pack-1/);
  assert.equal(summary.includes("Every pull request links a ticket."), false);
});

test("verifies the exact pack bytes", () => {
  const keys = makeKeyPair();
  const pinned = { "test-pack-1": keys.pem };
  const pack = ticketPack([
    rule,
    {
      id: "AY-NOTE-001",
      description: "A future advisory rule.",
      enforcement: "advisory",
      check: "future-rule",
    },
  ]);
  const { bytes, sigBytes } = signed(pack, keys.privateKey);
  const ok = verifyPack(bytes, sigBytes, pinned);
  assert.equal(ok.ok, true);
  assert.equal(ok.kid, "test-pack-1");
  assert.equal(ok.error, null);
  assert.deepEqual(ok.pack, pack);

  const pretty = Buffer.from(JSON.stringify(pack, null, 2));
  const whitespace = verifyPack(pretty, sigBytes, pinned);
  assert.equal(whitespace.ok, false);
  assert.equal(whitespace.error, "bad signature");

  const tampered = Buffer.from(JSON.stringify({ ...pack, version: "9.9.9" }));
  const changed = verifyPack(tampered, sigBytes, pinned);
  assert.equal(changed.ok, false);
  assert.equal(changed.error, "bad signature");
  assert.equal(changed.kid, "test-pack-1");
  assert.equal(JSON.parse(tampered.toString()).version, "9.9.9");
});

test("an unknown kid fails before the signature is accepted", () => {
  const keys = makeKeyPair();
  const pack = ticketPack();
  const { bytes, sigBytes } = signed(pack, keys.privateKey, "unknown-kid");
  const result = verifyPack(bytes, sigBytes, { "test-pack-1": keys.pem });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown kid");
  assert.equal(result.kid, "unknown-kid");
  const state = {
    policy: {
      baseSha: "b".repeat(40),
      pack: result,
      gate: { ok: true, approvers: [222], error: null },
    },
    pr: {
      repository: { owner: "me2resh", name: "apexyard-demo" },
      author: { id: 111, login: "author", type: "User" },
      headSha: "a".repeat(40),
      reviews: [],
      linkedIssues: [],
      commits: [],
      runRecords: [],
      agdrFiles: [],
    },
  };
  const verdict = evaluate(state.policy, state.pr);
  assert.equal(verdict.verdict, "fail");
  assert.equal(verdict.reasons[0].detail, "unknown kid");
});

test("the placeholder key rejects a signature from another key", () => {
  const keys = makeKeyPair();
  const { bytes, sigBytes } = signed(ticketPack(), keys.privateKey, "apexyard-pack-1");
  const result = verifyPack(bytes, sigBytes, PINNED_KEYS);
  assert.equal(result.ok, false);
  assert.equal(result.error, "bad signature");
  assert.match(PINNED_KEYS["apexyard-pack-1"], /BEGIN PUBLIC KEY/);
});

test("rejects a bad signature file", () => {
  const keys = makeKeyPair();
  const pinned = { "test-pack-1": keys.pem };
  const bytes = Buffer.from("{}");
  const as = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  const cases = [
    [undefined, as("{}"), pinned, null],
    [bytes, undefined, pinned, null],
    [bytes, as("{}"), null, null],
    [bytes, as("{}"), [], null],
    [bytes, as("{}"), 1, null],
    [bytes, Buffer.from("{"), pinned, null],
    [bytes, as(null), pinned, null],
    [bytes, as([]), pinned, null],
    [bytes, as("hi"), pinned, null],
    [bytes, as({ kid: "test-pack-1" }), pinned, null],
    [bytes, as({ a: 1, b: 2 }), pinned, null],
    [bytes, as({ kid: "test-pack-1", sig: "abc", extra: 1 }), pinned, null],
    [bytes, as({ sig: "abc", extra: 1 }), pinned, null],
    [bytes, as({ kid: "test-pack-1", extra: 1 }), pinned, null],
    [bytes, as({ kid: 1, sig: "abc" }), pinned, null],
    [bytes, as({ kid: "test-pack-1", sig: 1 }), pinned, "test-pack-1"],
    [bytes, as({ kid: "", sig: "abc" }), pinned, ""],
    [bytes, as({ kid: "test-pack-1", sig: "" }), pinned, "test-pack-1"],
  ];
  for (const [packBytes, sigBytes, keysForCall, kid] of cases) {
    const result = verifyPack(packBytes, sigBytes, keysForCall);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error, "invalid signature file");
    assert.equal(result.kid, kid);
  }
});

test("rejects a key that is not a PEM string", () => {
  const keys = makeKeyPair();
  const { bytes, sigBytes } = signed(ticketPack(), keys.privateKey);
  const missing = verifyPack(bytes, sigBytes, { "test-pack-1": 1 });
  assert.equal(missing.error, "unknown kid");
  const broken = verifyPack(bytes, sigBytes, { "test-pack-1": "not-a-key" });
  assert.equal(broken.error, "bad signature");
});

test("rejects signed bytes that are not a pack", () => {
  const keys = makeKeyPair();
  const pinned = { "test-pack-1": keys.pem };
  const text = signed("not-json", keys.privateKey);
  assert.equal(verifyPack(text.bytes, text.sigBytes, pinned).error, "invalid pack json");
  const incomplete = signed({ schema: "apexyard.pack/0" }, keys.privateKey);
  assert.equal(verifyPack(incomplete.bytes, incomplete.sigBytes, pinned).error, "invalid pack");
});

test("rejects an unsupported schema with a stable reason", () => {
  assert.equal(packSchemaError(schemaFixtures[1][1]), "unsupported pack schema");
  const keys = makeKeyPair();
  const { bytes, sigBytes } = signed(schemaFixtures[1][1], keys.privateKey);
  const verified = verifyPack(bytes, sigBytes, { "test-pack-1": keys.pem });
  assert.equal(verified.ok, false);
  assert.equal(verified.error, "unsupported pack schema");
  const state = baseState();
  state.policy.pack = verified;
  const result = evaluate(state.policy, state.pr);
  assert.equal(result.verdict, "fail");
  assert.equal(result.reasons[0].detail, "unsupported pack schema");
});

test("rejects an unknown top-level field", () => {
  assert.equal(packSchemaError(schemaFixtures[2][1]), "invalid pack");
});

test("rejects an unknown rule field", () => {
  assert.equal(packSchemaError(schemaFixtures[3][1]), "invalid pack");
});

test("rejects a bad team id", () => {
  assert.equal(packSchemaError(schemaFixtures[4][1]), "invalid pack");
});

test("rejects a duplicate rule id", () => {
  assert.equal(packSchemaError(schemaFixtures[5][1]), "invalid pack");
});

test("rejects an empty rules array", () => {
  assert.equal(packSchemaError(schemaFixtures[6][1]), "invalid pack");
});

test("rejects a bad semantic version", () => {
  assert.equal(packSchemaError(schemaFixtures[7][1]), "invalid pack");
});

test("rejects a rule id without the AY- prefix", () => {
  assert.equal(packSchemaError(ticketPack([{ ...rule, id: ruleIdWithoutPrefix }])), "invalid pack");
});

test("rejects a 67-character rule id", () => {
  assert.equal(longRuleId.length, 67);
  assert.equal(packSchemaError(ticketPack([{ ...rule, id: longRuleId }])), "invalid pack");
});

test("rejects a 65-character version", () => {
  assert.equal(longVersion.length, 65);
  assert.equal(packSchemaError({ ...cloudPack, version: longVersion }), "invalid pack");
});

test("rejects a missing rule description", () => {
  assert.equal(packSchemaError(schemaFixtures[8][1]), "invalid pack");
});

test("rejects invalid pack values and rule fields", () => {
  const { schema: _schema, ...missingSchema } = cloudPack;
  const cases = [
    null,
    [],
    missingSchema,
    { ...cloudPack, version: 1 },
    { ...cloudPack, team: 1 },
    { ...cloudPack, rules: "no" },
    ticketPack([null]),
    ticketPack(["no"]),
    ticketPack([{ ...rule, id: "ticket" }]),
    ticketPack([{ ...rule, description: 1 }]),
    ticketPack([{ ...rule, enforcement: "warn" }]),
    ticketPack([{ ...rule, check: "Linked" }]),
    ...schemaFixtures.slice(9).map(([, pack]) => pack),
  ];
  for (const pack of cases) assert.equal(packSchemaError(pack), "invalid pack");
});

test("the JSON Schema and hand-written validator agree for every fixture", () => {
  assert.equal(packSchema.properties.version.maxLength, 64);
  assert.equal(packSchema.properties.rules.items.properties.id.maxLength, 66);
  for (const [name, pack, expectedError] of schemaFixtures) {
    assert.equal(smallSchemaCheck(pack), expectedError == null, name);
    assert.equal(packSchemaError(pack), expectedError, name);
  }
});
