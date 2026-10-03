import assert from "node:assert/strict";
import { test } from "node:test";
import { SUMMARY_MAX_CHARS } from "../src/limits.js";
import { render } from "../src/render.js";
import { HEAD, RUN, rowsFor } from "../helpers/fixture-support.js";

const LONG_RULE_ID = `AY-${"A".repeat(64)}`;
const LONG_VERSION = `${"1".repeat(61)}.0.0`;

function cell(fact) {
  const summary = render({ facts: [fact] });
  const rows = rowsFor(summary, fact.fact);
  assert.equal(rows.length, 1, summary);
  assert.equal(rows[0].length, 3, summary);
  return rows[0][1];
}

const cases = [
  ["refuses a bad sha", { fact: "Head SHA", kind: "sha", value: "NOPE", label: "verified" }, "(refused)"],
  ["shows a sha", { fact: "Head SHA", kind: "sha", value: HEAD, label: "verified" }, HEAD],
  ["shows a base ref", { fact: "Base ref", kind: "ref", value: "evil-base", label: "verified" }, "evil-base"],
  ["shows the default branch", { fact: "Default branch", kind: "ref", value: "main", label: "verified" }, "main"],
  ["refuses a ref that contains a parent segment", {
    fact: "Base ref",
    kind: "ref",
    value: "release/../main",
    label: "verified",
  }, "(refused)"],
  ["refuses a ref that fails the pattern", {
    fact: "Default branch",
    kind: "ref",
    value: "bad ref",
    label: "verified",
  }, "(refused)"],
  ["refuses a ref that is not a string", {
    fact: "Base ref",
    kind: "ref",
    value: null,
    label: "verified",
  }, "(refused)"],
  ["shows a signed pack", {
    fact: "Pack version, team and signature",
    kind: "pack",
    value: { version: "0.1.0", team: "demo", result: "ok", kid: "apexyard-pack-1" },
    label: "verified by signature",
  }, "0.1.0 demo ok apexyard-pack-1"],
  ["omits a null pack version", {
    fact: "Pack version, team and signature",
    kind: "pack",
    value: { version: null, team: null, result: "bad signature", kid: "test-pack-1" },
    label: "verified by signature",
  }, "bad signature test-pack-1"],
  ["skips a kid that fails the pattern", {
    fact: "Pack version, team and signature",
    kind: "pack",
    value: { version: "1.0.0", team: "demo", result: "ok", kid: "BAD" },
    label: "verified by signature",
  }, "1.0.0 demo ok"],
  ["refuses a bad pack version", {
    fact: "Pack version, team and signature",
    kind: "pack",
    value: { version: "bad version", team: "demo", result: "ok", kid: null },
    label: "verified by signature",
  }, "(refused)"],
  ["refuses a 65-character pack version", {
    fact: "Pack version, team and signature",
    kind: "pack",
    value: { version: LONG_VERSION, team: "demo", result: "ok", kid: null },
    label: "verified by signature",
  }, "(refused)"],
  ["refuses a bad pack team", {
    fact: "Pack version, team and signature",
    kind: "pack",
    value: { version: "1.0.0", team: "Demo", result: "ok", kid: null },
    label: "verified by signature",
  }, "(refused)"],
  ["refuses a bad pack result", {
    fact: "Pack version, team and signature",
    kind: "pack",
    value: { version: "1.0.0", team: "demo", result: "nope", kid: null },
    label: "verified by signature",
  }, "(refused)"],
  ["refuses a pack value that is not an object", {
    fact: "Pack version, team and signature",
    kind: "pack",
    value: null,
    label: "verified by signature",
  }, "(refused)"],
  ["shows no tickets for an empty list", {
    fact: "Linked ticket",
    kind: "tickets",
    value: [],
    label: "verified",
  }, "none"],
  ["shows ticket numbers", {
    fact: "Linked ticket",
    kind: "tickets",
    value: [7, 12],
    label: "verified",
  }, "7, 12"],
  ["refuses a ticket number of zero", {
    fact: "Linked ticket",
    kind: "tickets",
    value: [0],
    label: "verified",
  }, "(refused)"],
  ["shows an approver", {
    fact: "Approver",
    kind: "approver",
    value: { login: "approver", id: 222, reviewId: 50, commitId: HEAD },
    label: "verified",
  }, `approver 222 50 ${HEAD}`],
  ["drops an approver login that fails the pattern", {
    fact: "Approver",
    kind: "approver",
    value: { login: "bad login", id: 222, reviewId: 50, commitId: HEAD },
    label: "verified",
  }, `222 50 ${HEAD}`],
  ["refuses an approver on a bad commit", {
    fact: "Approver",
    kind: "approver",
    value: { login: "approver", id: 222, reviewId: 50, commitId: "nope" },
    label: "verified",
  }, "(refused)"],
  ["shows an author", {
    fact: "PR author",
    kind: "author",
    value: { login: "a", id: 5 },
    label: "verified",
  }, "a 5"],
  ["drops an author login that fails the pattern", {
    fact: "PR author",
    kind: "author",
    value: { login: "a b", id: 111 },
    label: "verified",
  }, "111"],
  ["refuses an author that is not an object", {
    fact: "PR author",
    kind: "author",
    value: null,
    label: "verified",
  }, "(refused)"],
  ["shows the fixed last-pusher value", {
    fact: "Last pusher",
    kind: "fixed",
    value: "not checked",
    label: "not checked by the gate. The ruleset checks it.",
  }, "not checked"],
  ["refuses an unknown fixed value", {
    fact: "Last pusher",
    kind: "fixed",
    value: "maybe",
    label: "not checked by the gate. The ruleset checks it.",
  }, "(refused)"],
  ["shows the trailer count", {
    fact: "Run trailers",
    kind: "trailer-count",
    value: { left: 1, right: 2 },
    label: "reported",
  }, "1 of 2 commits carry the trailer"],
  ["shows a zero trailer count", {
    fact: "Run trailers",
    kind: "trailer-count",
    value: { left: 0, right: 0 },
    label: "reported",
  }, "0 of 0 commits carry the trailer"],
  ["refuses a trailer count that exceeds the total", {
    fact: "Run trailers",
    kind: "trailer-count",
    value: { left: 3, right: 1 },
    label: "reported",
  }, "(refused)"],
  ["refuses a negative trailer count", {
    fact: "Run ids",
    kind: "run-count",
    value: { left: -1, right: 2 },
    label: "reported",
  }, "(refused)"],
  ["shows how many run ids were read", {
    fact: "Run ids",
    kind: "run-count",
    value: { left: 5, right: 6 },
    label: "reported",
  }, "5 of 6 run ids read"],
  ["shows a record that was not reported", {
    fact: "Run record",
    kind: "record",
    value: { runId: RUN, state: "not reported" },
    label: "reported",
  }, `${RUN} not reported`],
  ["shows a record that was not read", {
    fact: "Run record",
    kind: "record",
    value: { runId: RUN, state: "not read" },
    label: "reported",
  }, `${RUN} not read`],
  ["refuses an unknown record state", {
    fact: "Run record",
    kind: "record",
    value: { runId: RUN, state: "parsed" },
    label: "reported",
  }, "(refused)"],
  ["shows a slice", {
    fact: "ORBIT slice",
    kind: "slice",
    value: { runId: RUN, sliceId: "slice-plan-demo" },
    label: "reported",
  }, `${RUN} slice-plan-demo`],
  ["shows a null slice as none", {
    fact: "ORBIT slice",
    kind: "slice",
    value: { runId: RUN, sliceId: null },
    label: "reported",
  }, `${RUN} none`],
  ["refuses a slice id that fails the pattern", {
    fact: "ORBIT slice",
    kind: "slice",
    value: { runId: RUN, sliceId: "Slice" },
    label: "reported",
  }, "(refused)"],
  ["shows the catalogue", {
    fact: "Harness, mode and model",
    kind: "catalogue",
    value: { runId: RUN, harness: "claude", mode: "default", model: "default" },
    label: "reported",
  }, `${RUN} claude default default`],
  ["refuses a catalogue mode that fails the pattern", {
    fact: "Harness, mode and model",
    kind: "catalogue",
    value: { runId: RUN, harness: "claude", mode: "Default", model: "default" },
    label: "reported",
  }, "(refused)"],
  ["shows a path in a code span", {
    fact: "AgDR path",
    kind: "path",
    value: "docs/agdr/AgDR-0001-note.md",
    label: "presence verified",
  }, "`docs/agdr/AgDR-0001-note.md`"],
  ["refuses a path outside the AgDR folder", {
    fact: "AgDR path",
    kind: "path",
    value: "docs/runs/nope.md",
    label: "presence verified",
  }, "(refused)"],
  ["refuses a path with a parent segment", {
    fact: "AgDR path",
    kind: "path",
    value: "docs/agdr/AgDR-a..b.md",
    label: "presence verified",
  }, "(refused)"],
  ["refuses a path with a newline", {
    fact: "AgDR path",
    kind: "path",
    value: "docs/agdr/AgDR-a\nb.md",
    label: "presence verified",
  }, "(refused)"],
  ["refuses a path with a carriage return", {
    fact: "AgDR path",
    kind: "path",
    value: "docs/agdr/AgDR-a\rb.md",
    label: "presence verified",
  }, "(refused)"],
  ["refuses a path with a backtick", {
    fact: "AgDR path",
    kind: "path",
    value: "docs/agdr/AgDR-bad`name.md",
    label: "presence verified",
  }, "(refused)"],
  ["shows a run id", {
    fact: "AgDR run link",
    kind: "run-id",
    value: RUN,
    label: "reported",
  }, RUN],
  ["shows a missing run link as not reported", {
    fact: "AgDR run link",
    kind: "run-id",
    value: null,
    label: "reported",
  }, "not reported"],
  ["refuses a run id that fails the pattern", {
    fact: "AgDR run link",
    kind: "run-id",
    value: "run-1",
    label: "reported",
  }, "(refused)"],
  ["shows a count", {
    fact: "AgDR files not read",
    kind: "count",
    value: 4,
    label: "presence verified",
  }, "4"],
  ["shows a zero count", {
    fact: "AgDR files not read",
    kind: "count",
    value: 0,
    label: "presence verified",
  }, "0"],
  ["refuses a fractional count", {
    fact: "AgDR files not read",
    kind: "count",
    value: 1.5,
    label: "presence verified",
  }, "(refused)"],
  ["shows a rule", {
    fact: "Rule",
    kind: "rule",
    value: { id: "AY-TICKET-001", outcome: "pass", detail: "open linked issue" },
    label: "verified",
  }, "AY-TICKET-001 pass open linked issue"],
  ["refuses a rule id without the AY- prefix", {
    fact: "Rule",
    kind: "rule",
    value: { id: "X-1", outcome: "pass", detail: "open linked issue" },
    label: "verified",
  }, "(refused)"],
  ["refuses a 67-character rule id", {
    fact: "Rule",
    kind: "rule",
    value: { id: LONG_RULE_ID, outcome: "pass", detail: "open linked issue" },
    label: "verified",
  }, "(refused)"],
  ["shows a pack rule", {
    fact: "Rule",
    kind: "rule",
    value: { id: "pack", outcome: "fail", detail: "bad signature" },
    label: "blocking",
  }, "pack fail bad signature"],
  ["refuses a rule detail outside the phrase list", {
    fact: "Rule",
    kind: "rule",
    value: { id: "AY-TICKET-001", outcome: "pass", detail: "hello" },
    label: "verified",
  }, "(refused)"],
  ["refuses an unknown kind", {
    fact: "Head SHA",
    kind: "other",
    value: HEAD,
    label: "verified",
  }, "(refused)"],
];

for (const [name, fact, expected] of cases) {
  test(name, () => {
    assert.equal(cell(fact), expected);
  });
}

test("escapes a pipe in a path", () => {
  const fact = {
    fact: "AgDR path",
    kind: "path",
    value: "docs/agdr/AgDR-a|b.md",
    label: "presence verified",
  };
  const summary = render({ facts: [fact] });
  assert.equal(rowsFor(summary, "AgDR path")[0][1], "`docs/agdr/AgDR-a\\|b.md`");
  assert.equal(summary.includes("a|b"), false);
});

test("a refused backtick path is not copied into the summary", () => {
  const summary = render({
    facts: [{
      fact: "AgDR path",
      kind: "path",
      value: "docs/agdr/AgDR-bad`name.md",
      label: "presence verified",
    }],
  });
  assert.equal(summary.includes("`"), false, summary);
  assert.equal(summary.includes("(refused)"), true);
});

test("a refused parent path is not copied into the summary", () => {
  const summary = render({
    facts: [{
      fact: "AgDR path",
      kind: "path",
      value: "docs/agdr/AgDR-a..b.md",
      label: "presence verified",
    }],
  });
  assert.equal(summary.includes("AgDR-a..b.md"), false);
});

test("skips unknown facts and labels", () => {
  const summary = render({
    facts: [
      null,
      { fact: "Nope", kind: "sha", value: HEAD, label: "verified" },
      { fact: "Head SHA", kind: "sha", value: HEAD, label: "untrusted" },
    ],
  });
  assert.equal(summary.includes(HEAD), false);
  assert.equal(summary.includes("Nope"), false);
});

test("renders an empty table when evidence is missing", () => {
  for (const evidence of [null, undefined, {}, { facts: null }]) {
    const summary = render(evidence);
    assert.equal(summary.startsWith("| Fact | Value | Label |"), true);
    assert.equal(summary.includes(HEAD), false);
  }
});

test("truncates a summary at the character cap", () => {
  const path = `docs/agdr/AgDR-${"p".repeat(180)}.md`;
  const facts = [];
  for (let index = 0; index < 400; index += 1) {
    facts.push({ fact: "AgDR path", kind: "path", value: path, label: "presence verified" });
  }
  const summary = render({ facts });
  assert.equal(summary.length, SUMMARY_MAX_CHARS);
  assert.equal(summary.endsWith("(truncated)"), true);
});
