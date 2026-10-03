import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evaluate.js";
import { render } from "../src/render.js";
import {
  APPROVER_ID,
  HEAD,
  RUN,
  baseState,
  issue,
  review,
  rowsFor,
  validRecord,
} from "../helpers/fixture-support.js";

function fresh() {
  return structuredClone(baseState());
}

function run(state) {
  const result = evaluate(state.policy, state.pr);
  return { result, summary: render(result.evidence) };
}

test("keeps one open issue among rejected links", () => {
  const state = fresh();
  state.pr.linkedIssues = [
    null,
    issue({ number: 0 }),
    issue({ number: 1.5 }),
    { number: 3, state: "OPEN" },
    { number: 4, state: "OPEN", repository: { owner: 1, name: "apexyard-demo" } },
    { number: 5, state: "OPEN", repository: { owner: "me2resh", name: 2 } },
    issue({ number: 6, state: "CLOSED" }),
    issue({ number: 9, repository: { owner: "other-org", name: "apexyard-demo" } }),
    issue({ number: 8, repository: { owner: "Me2resh", name: "Apexyard-Demo" } }),
    issue({ number: 8 }),
  ];
  const { result, summary } = run(state);
  assert.equal(result.verdict, "pass");
  assert.deepEqual(rowsFor(summary, "Linked ticket").map((cells) => cells[1]), ["8"]);
});

test("lists every open issue in this repository", () => {
  const state = fresh();
  state.pr.linkedIssues = [issue({ number: 7 }), issue({ number: 12 })];
  const { summary } = run(state);
  assert.equal(rowsFor(summary, "Linked ticket")[0][1], "7, 12");
});

test("ignores reviews that cannot approve", () => {
  const state = fresh();
  state.pr.reviews = [
    null,
    { user: null, state: "APPROVED" },
    { user: "nope", state: "APPROVED" },
    {
      id: 3,
      state: "APPROVED",
      commit_id: HEAD,
      submitted_at: "2026-10-01T12:00:00Z",
      user: { id: "222", login: "approver", type: "User" },
    },
    {
      id: 4,
      state: "APPROVED",
      commit_id: HEAD,
      submitted_at: 5,
      user: { id: APPROVER_ID, login: "approver", type: "User" },
    },
    {
      id: 5,
      state: "APPROVED",
      commit_id: HEAD,
      submitted_at: "yesterday",
      user: { id: APPROVER_ID, login: "approver", type: "User" },
    },
    review({ id: 6 }),
    review({ id: 7, state: "PENDING", submitted_at: "2026-10-01T18:00:00Z" }),
  ];
  assert.equal(run(state).result.verdict, "pass");
});

test("a string user id does not approve", () => {
  const state = fresh();
  state.pr.reviews = [{
    id: 3,
    state: "APPROVED",
    commit_id: HEAD,
    submitted_at: "2026-10-01T12:00:00Z",
    user: { id: "222", login: "approver", type: "User" },
  }];
  assert.equal(run(state).result.verdict, "fail");
});

test("a later pending review leaves the approval in place", () => {
  const state = fresh();
  state.pr.reviews = [
    review({ id: 1, submitted_at: "2026-10-01T12:00:00Z" }),
    review({ id: 2, state: "PENDING", submitted_at: "2026-10-01T18:00:00Z" }),
  ];
  assert.equal(run(state).result.verdict, "pass");
});

test("the higher review id wins when timestamps match", () => {
  const state = fresh();
  state.pr.reviews = [
    review({ id: 10, state: "APPROVED", submitted_at: "2026-10-01T12:00:00Z" }),
    review({ id: 20, state: "CHANGES_REQUESTED", submitted_at: "2026-10-01T12:00:00Z" }),
  ];
  assert.equal(run(state).result.verdict, "fail");
});

test("an older request for changes does not replace a newer approval", () => {
  const state = fresh();
  state.pr.reviews = [
    review({ id: 20, state: "APPROVED", submitted_at: "2026-10-01T13:00:00Z" }),
    review({ id: 10, state: "CHANGES_REQUESTED", submitted_at: "2026-10-01T12:00:00Z" }),
  ];
  assert.equal(run(state).result.verdict, "pass");
  state.pr.reviews = [
    review({ id: 20, state: "APPROVED", submitted_at: "2026-10-01T12:00:00Z" }),
    review({ id: 10, state: "CHANGES_REQUESTED", submitted_at: "2026-10-01T12:00:00Z" }),
  ];
  assert.equal(run(state).result.verdict, "pass");
});

test("a missing gate object fails the approval", () => {
  const state = fresh();
  state.policy.gate = null;
  const { result } = run(state);
  assert.equal(result.verdict, "fail");
  assert.equal(result.reasons.find((item) => item.id === "approval").detail, "invalid gate.json");
});

test("a missing pack object fails closed", () => {
  const state = fresh();
  state.policy.pack = null;
  const { result } = run(state);
  assert.equal(result.verdict, "fail");
  assert.equal(result.reasons.find((item) => item.id === "pack").detail, "invalid pack");
});

test("a pack without the linked-ticket rule fails", () => {
  const state = fresh();
  state.policy.pack.pack.rules = [{
    id: "AY-NOTE-001",
    description: "A future advisory rule.",
    enforcement: "advisory",
    check: "future-rule",
  }];
  const { result } = run(state);
  assert.equal(result.verdict, "fail");
  assert.deepEqual(
    result.reasons.map(({ id, outcome }) => [id, outcome]),
    [
      ["AY-NOTE-001", "not evaluated"],
      ["AY-TICKET-001", "fail"],
      ["approval", "pass"],
    ],
  );
});

test("a mismatched run id is not reported", () => {
  const state = fresh();
  state.pr.runRecords = [{
    runId: RUN,
    status: "parsed",
    json: validRecord("ayr-20261001T120000Z-bbbbbbbb", { sliceId: "slice-secret-mismatch" }),
  }];
  const { summary } = run(state);
  assert.equal(summary.includes("slice-secret-mismatch"), false);
  assert.equal(summary.includes("not reported"), true);
});

test("the first record for a run id wins", () => {
  const state = fresh();
  state.pr.runRecords = [
    { runId: RUN, status: "missing" },
    null,
    { status: "parsed", json: validRecord(RUN) },
    {
      runId: RUN,
      status: "parsed",
      json: validRecord(RUN, { sliceId: "slice-secret-second" }),
    },
  ];
  const { summary } = run(state);
  assert.equal(summary.includes("slice-secret-second"), false);
  assert.equal(summary.includes("slice-plan-demo"), false);
  assert.equal(summary.includes("not reported"), true);
});

test("a null slice is reported as none", () => {
  const state = fresh();
  state.pr.runRecords = [{
    runId: RUN,
    status: "parsed",
    json: validRecord(RUN, { sliceId: null }),
  }];
  const { summary } = run(state);
  assert.equal(rowsFor(summary, "ORBIT slice")[0][1], `${RUN} none`);
});

test("a record may name a team and a signed-in account", () => {
  const state = fresh();
  state.pr.runRecords = [{
    runId: RUN,
    status: "parsed",
    json: validRecord(RUN, {
      sliceId: "slice-team-ok",
      team: {
        id: "demo",
        pack_version: "1.0.0",
        pack_sha256: "cd".repeat(32),
      },
      signedIn: { github_id: APPROVER_ID, login: "approver" },
    }),
  }];
  const { result, summary } = run(state);
  assert.equal(result.verdict, "pass");
  assert.equal(summary.includes("slice-team-ok"), true, summary);
});

test("missing text has no run link", () => {
  const state = fresh();
  state.pr.agdrFiles = [{ path: "docs/agdr/AgDR-0009-empty.md", text: null }];
  const { summary } = run(state);
  assert.equal(rowsFor(summary, "AgDR path")[0][1], "`docs/agdr/AgDR-0009-empty.md`");
  assert.equal(rowsFor(summary, "AgDR run link")[0][1], "not reported");
});

test("the omitted AgDR count is shown only for a positive integer", () => {
  const shown = fresh();
  shown.pr.agdrOmitted = 4;
  assert.equal(rowsFor(run(shown).summary, "AgDR files not read")[0][1], "4");
  const zero = fresh();
  zero.pr.agdrOmitted = 0;
  assert.equal(rowsFor(run(zero).summary, "AgDR files not read").length, 0);
  const fraction = fresh();
  fraction.pr.agdrOmitted = 1.5;
  assert.equal(rowsFor(run(fraction).summary, "AgDR files not read").length, 0);
});

test("missing lists do not throw", () => {
  const state = fresh();
  state.pr.linkedIssues = null;
  state.pr.reviews = null;
  state.pr.runRecords = null;
  state.pr.agdrFiles = null;
  state.pr.commits = null;
  const { result, summary } = run(state);
  assert.equal(result.verdict, "fail");
  assert.equal(summary.includes("SECRET-PR-TITLE"), false);
});
