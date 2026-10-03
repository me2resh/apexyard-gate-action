import { createSign, generateKeyPairSync } from "node:crypto";

export const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const OLD = "cccccccccccccccccccccccccccccccccccccccc";
export const DECOY = "dddddddddddddddddddddddddddddddddddddddd";
export const RUN = "ayr-20261001T120000Z-aaaaaaaa";
export const MENTIONED = "ayr-20261001T120000Z-ffffffff";
export const AUTHOR_ID = 111;
export const APPROVER_ID = 222;
export const OUTSIDER_ID = 333;

export const POISON = {
  issue: "SECRET-ISSUE-TITLE",
  commit: "SECRET-COMMIT-SUBJECT",
  agdr: "SECRET-AGDR-BODY",
  pr: "SECRET-PR-TITLE",
  body: "SECRET-PR-BODY",
};

export function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicKey,
    privateKey,
    pem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

export function signBytes(bytes, privateKey) {
  const signer = createSign("SHA256");
  signer.update(bytes);
  signer.end();
  return signer.sign({ key: privateKey, dsaEncoding: "der" }).toString("base64");
}

export function ticketRule() {
  return {
    id: "AY-TICKET-001",
    description: "Every pull request links a ticket.",
    enforcement: "blocking",
    check: "linked-ticket",
  };
}

export function ticketPack(rules = [ticketRule()]) {
  return {
    schema: "apexyard.pack/0",
    version: "0.1.0",
    team: "demo",
    rules,
  };
}

export function review(fields) {
  return {
    id: 50,
    state: "APPROVED",
    commit_id: HEAD,
    submitted_at: "2026-10-01T12:00:00Z",
    user: { id: APPROVER_ID, login: "approver", type: "User" },
    ...fields,
  };
}

export function issue(fields = {}) {
  return {
    number: 7,
    state: "OPEN",
    title: POISON.issue,
    repository: { owner: "me2resh", name: "apexyard-demo" },
    ...fields,
  };
}

export function validRecord(runId, options = {}) {
  const sliceId = Object.hasOwn(options, "sliceId") ? options.sliceId : "slice-plan-demo";
  const agdrPaths = options.agdrPaths ?? ["docs/agdr/AgDR-0001-note.md"];
  const team = Object.hasOwn(options, "team")
    ? options.team
    : null;
  const signedIn = Object.hasOwn(options, "signedIn")
    ? options.signedIn
    : null;
  const record = {
    v: 1,
    kind: "apexyard.run-record",
    run_id: runId,
    job: {
      v: 1,
      job_id: "ayj-20261001T120000Z-aaaaaaaa",
      entry_point: "runner-click",
      repo: { owner: "me2resh", name: "apexyard-demo" },
      issue: 7,
      issue_body_sha256: "ab".repeat(32),
      base: { ref: "main", sha: BASE },
      slice_id: sliceId,
      harness: "claude",
      mode: "default",
      model: "default",
      team,
      requested_by: { github_id: AUTHOR_ID, login: "author", source: "gh-cli" },
      signed_in_as: signedIn,
      requested_at: "2026-10-01T12:00:00Z",
    },
    branch: "feature/GH-7-note",
    agdr_paths: agdrPaths,
    runner_version: "0.3.0",
    created_at: "2026-10-01T12:00:00Z",
  };
  if (options.extra) Object.assign(record, options.extra);
  return record;
}

export function agdrDocument(runId, body = POISON.agdr) {
  return `---\nid: AgDR-0001\nrun: ${runId}\n---\n\n${body}\n`;
}

export function baseState() {
  const pack = ticketPack();
  return {
    policy: {
      baseSha: BASE,
      pack: {
        ok: true,
        kid: "apexyard-pack-1",
        version: pack.version,
        team: pack.team,
        pack,
        error: null,
      },
      gate: { ok: true, approvers: [APPROVER_ID], error: null },
    },
    pr: {
      repository: { owner: "me2resh", name: "apexyard-demo" },
      number: 7,
      title: POISON.pr,
      body: POISON.body,
      author: { id: AUTHOR_ID, login: "author", type: "User" },
      headSha: HEAD,
      base: { ref: "main", sha: BASE },
      reviews: [
        review({}),
        review({
          id: 51,
          state: "COMMENTED",
          submitted_at: "2026-10-01T15:00:00Z",
        }),
      ],
      linkedIssues: [issue()],
      commits: [{
        sha: HEAD,
        message: `${POISON.commit}\n\nSee ApexYard-Run: ${MENTIONED}\n\nApexYard-Run: ${RUN}\n`,
      }],
      runRecords: [{
        runId: RUN,
        status: "parsed",
        json: validRecord(RUN),
      }],
      agdrFiles: [{
        path: "docs/agdr/AgDR-0001-note.md",
        text: agdrDocument(RUN),
      }],
      agdrOmitted: 0,
    },
  };
}

export function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    throw new Error(`not a row: ${line}`);
  }
  const body = trimmed.slice(1, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "\\" && body[i + 1] === "|") {
      current += "\\|";
      i += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

export function rowsFor(summary, fact) {
  return summary
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map(tableCells)
    .filter((cells) => cells[0] === fact);
}
