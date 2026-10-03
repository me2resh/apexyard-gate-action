import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluate } from "../src/evaluate.js";
import { SUMMARY_MAX_CHARS } from "../src/limits.js";
import { render } from "../src/render.js";
import { MENTIONED, POISON, rowsFor } from "../helpers/fixture-support.js";

const dir = new URL("./fixtures/evaluate/", import.meta.url);
const required = [
  "pass.json",
  "no-linked-issue.json",
  "linked-other-repo.json",
  "closed-linked-issue.json",
  "approval-by-author.json",
  "approval-by-non-approver.json",
  "approval-by-bot.json",
  "approval-older-sha.json",
  "approval-then-changes-requested.json",
  "dismissed-approval.json",
  "unknown-blocking-rule.json",
  "unknown-advisory-rule.json",
  "backtick-path.json",
  "unknown-keys.json",
  "pipe-in-value.json",
  "agdr-run-outside-frontmatter.json",
];

const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();

test("evaluate fixtures cover the required cases", () => {
  for (const name of required) assert.ok(files.includes(name), name);
});

for (const name of files) {
  test(name, () => {
    const fixture = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
    const result = evaluate(fixture.policy, fixture.pr);
    const summary = render(result.evidence);
    assert.equal(result.verdict, fixture.expect.verdict);
    assert.deepEqual(
      result.reasons.map(({ id, outcome, detail }) => ({ id, outcome, detail })),
      fixture.expect.reasons,
    );
    assert.ok(summary.length <= SUMMARY_MAX_CHARS);
    assert.equal(summary.startsWith("| Fact | Value | Label |"), true);
    const last = rowsFor(summary, "Last pusher");
    assert.equal(last.length, 1, summary);
    assert.equal(last[0][1], "not checked");
    assert.equal(last[0][2], "not checked by the gate. The ruleset checks it.");
    for (const part of fixture.expect.summaryIncludes ?? []) {
      assert.equal(summary.includes(part), true, `missing ${part}\n${summary}`);
    }
    for (const part of [POISON.issue, POISON.commit, POISON.agdr, POISON.pr, POISON.body, MENTIONED, ...(fixture.expect.summaryExcludes ?? [])]) {
      assert.equal(summary.includes(part), false, `found ${part}\n${summary}`);
    }
    if (fixture.expect.forbidBacktick) assert.equal(summary.includes("`"), false, summary);
    for (const expected of fixture.expect.rows ?? []) {
      const found = rowsFor(summary, expected.fact);
      const match = found.find((cells) => {
        if (expected.value !== undefined && cells[1] !== expected.value) return false;
        if (expected.label !== undefined && cells[2] !== expected.label) return false;
        if (expected.valueIncludes && !cells[1].includes(expected.valueIncludes)) return false;
        return cells.length === 3;
      });
      assert.ok(match, `${expected.fact} ${expected.value ?? ""} missing\n${summary}`);
    }
    for (const line of summary.split("\n")) {
      if (!line.startsWith("|")) continue;
      assert.equal(countCells(line), 3, line);
    }
  });
}

function countCells(line) {
  const body = line.trim().slice(1, -1);
  let count = 1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "\\" && body[i + 1] === "|") {
      i += 1;
      continue;
    }
    if (body[i] === "|") count += 1;
  }
  return count;
}
