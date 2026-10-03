import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/shell.js";
import {
  APPROVER_ID,
  AUTHOR_ID,
  BASE,
  DECOY,
  HEAD,
  MENTIONED,
  POISON,
  RUN,
  issue,
  makeKeyPair,
  review,
  rowsFor,
  signBytes,
  ticketPack,
  validRecord,
} from "../helpers/fixture-support.js";

const STALE = "e".repeat(40);
const EVIL = "f".repeat(40);
const APP_TOKEN = "ghs_test-installation-token";
const { privateKey: appPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_KEY = appPrivateKey.export({ type: "pkcs8", format: "pem" });
const dir = new URL("./fixtures/shell/", import.meta.url);
const required = [
  "changes-requested-page-2.json",
  "tampered-pack.json",
  "unsigned-pack.json",
  "unknown-kid.json",
  "missing-pack.json",
  "missing-gate.json",
  "shell-exception.json",
  "record-over-4kb.json",
  "sixth-record.json",
  "non-default-base.json",
  "closed-pr.json",
];

function wrap64(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/.{1,60}/g, "$&\n");
}

function recordBytes(entry) {
  const json = JSON.stringify(validRecord(entry.id, { sliceId: entry.slice }));
  if (!entry.padTo) return Buffer.from(json);
  if (json.length > entry.padTo) throw new Error(`record is already ${json.length} bytes`);
  return Buffer.from(json + " ".repeat(entry.padTo - json.length));
}

function respond(status, body, headers = {}) {
  return {
    status,
    headers: new Headers(headers),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function fileResponse(bytes) {
  return respond(200, {
    type: "file",
    encoding: "base64",
    size: bytes.length,
    content: wrap64(bytes),
  });
}

async function execute(fixture) {
  const baseRef = fixture.baseRef ?? "main";
  const defaultBranch = fixture.defaultBranch ?? "main";
  const pullState = fixture.pullState ?? "open";
  const keys = makeKeyPair();
  const pack = ticketPack();
  const original = Buffer.from(JSON.stringify(pack));
  const servedPack = fixture.packMode === "tampered"
    ? Buffer.from(JSON.stringify({ ...pack, version: "9.9.9" }))
    : original;
  if (fixture.packMode === "tampered") {
    assert.notEqual(Buffer.compare(servedPack, original), 0);
    assert.equal(JSON.parse(servedPack.toString()).version, "9.9.9");
  }
  const kid = fixture.packMode === "unknown-kid" ? "unknown-kid" : "test-pack-1";
  const sigBytes = Buffer.from(JSON.stringify({
    kid,
    sig: signBytes(original, keys.privateKey),
  }));
  const trailers = fixture.trailers ?? [RUN];
  const reviewPages = fixture.reviewPages ?? [[review({})]];
  const linked = fixture.linkedIssues ?? [issue()];
  let agdr = (fixture.agdr ?? []).map((file) => ({ ...file }));
  if (fixture.agdrCount) {
    agdr = [];
    for (let n = 1; n <= fixture.agdrCount; n += 1) {
      const id = n === fixture.agdrCount ? fixture.poisonRunId : "ayr-20261001T130000Z-000000aa";
      agdr.push({
        filename: `docs/agdr/AgDR-file-${String(n).padStart(2, "0")}.md`,
        status: "added",
        text: `---\nrun: ${id}\n---\n`,
      });
    }
  }
  const agdrBytes = new Map(agdr.map((file) => {
    let text = file.text ?? "";
    if (file.padTo && text.length < file.padTo) text += " ".repeat(file.padTo - text.length);
    return [file.filename, Buffer.from(text)];
  }));
  const runBytes = new Map((fixture.runs ?? []).map((entry) => [entry.id, recordBytes(entry)]));
  const calls = [];
  const contentFetches = [];
  const unexpected = [];
  const prefix = "/repos/me2resh/apexyard-demo";

  function gateDocument(ref) {
    if (fixture.gateMode === "invalid" && ref !== EVIL) return { v: 2, approvers: [APPROVER_ID] };
    if (fixture.gates) {
      const branch = ref === EVIL ? baseRef : defaultBranch;
      if (fixture.gates[branch]) return fixture.gates[branch];
    }
    return { v: 1, approvers: [APPROVER_ID] };
  }

  function fetchImpl(url, init) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, path });
    assert.equal(parsed.hostname, "api.github.com");
    assert.equal(init.redirect, "error");
    if (path === `${prefix}/installation` || path === "/app/installations/808/access_tokens") {
      assert.match(init.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
    } else if (path.startsWith(`${prefix}/check-runs`)) {
      assert.equal(init.headers.Authorization, `Bearer ${APP_TOKEN}`);
    } else {
      assert.equal(init.headers.Authorization, "Bearer test-token");
    }
    assert.equal(init.headers["User-Agent"], "apexyard-gate");
    assert.equal(init.headers.Accept, "application/vnd.github+json");
    if (init.method === "GET") assert.equal(init.headers["Content-Type"], undefined);
    else assert.equal(init.headers["Content-Type"], "application/json");
    if (fixture.throwOn === "base-ref" && parsed.pathname.endsWith("/git/ref/heads/main")) {
      throw new Error("boom");
    }
    if (path === `${prefix}/installation` && init.method === "GET") {
      return respond(200, { id: 808 });
    }
    if (path === "/app/installations/808/access_tokens" && init.method === "POST") {
      assert.deepEqual(JSON.parse(init.body), {
        repositories: ["apexyard-demo"],
        permissions: { checks: "write" },
      });
      return respond(201, { token: APP_TOKEN });
    }
    if (path === `${prefix}/pulls/7` && init.method === "GET") {
      return respond(200, {
        number: 7,
        title: POISON.pr,
        body: POISON.body,
        head: { sha: HEAD },
        base: { ref: baseRef, sha: STALE },
        state: pullState,
        user: { id: AUTHOR_ID, login: "author", type: "User" },
      });
    }
    if (path === prefix && init.method === "GET") {
      return respond(200, { default_branch: defaultBranch });
    }
    if (path === `${prefix}/check-runs` && init.method === "POST") return respond(200, { id: 101 });
    if (path === `${prefix}/check-runs/101` && init.method === "PATCH") return respond(200, { id: 101 });
    if (path.startsWith(`${prefix}/git/ref/heads/`)) {
      const branch = path.slice(`${prefix}/git/ref/heads/`.length).split("/").map(decodeURIComponent).join("/");
      if (branch === defaultBranch) return respond(200, { object: { sha: BASE } });
      if (branch === baseRef) return respond(200, { object: { sha: EVIL } });
      unexpected.push(url);
      return respond(500, "unexpected");
    }
    if (path.startsWith(`${prefix}/contents/`)) {
      const rel = path.slice(`${prefix}/contents/`.length).split("/").map(decodeURIComponent).join("/");
      contentFetches.push(rel);
      const ref = parsed.searchParams.get("ref");
      if (rel.startsWith(".apexyard/") && ref !== EVIL) assert.equal(ref, BASE, rel);
      if (rel.startsWith("docs/")) assert.equal(ref, HEAD, rel);
      assert.notEqual(ref, STALE);
      assert.notEqual(ref, DECOY);
      if (rel === ".apexyard/pack.json") {
        return fixture.packMode === "missing" ? respond(404, "") : fileResponse(servedPack);
      }
      if (rel === ".apexyard/pack.json.sig") {
        return fixture.packMode === "unsigned" ? respond(404, "") : fileResponse(sigBytes);
      }
      if (rel === ".apexyard/gate.json") {
        return fixture.gateMode === "missing" ? respond(404, "") : fileResponse(Buffer.from(JSON.stringify(gateDocument(ref))));
      }
      if (rel.startsWith("docs/runs/") && rel.endsWith(".json")) {
        const id = rel.slice("docs/runs/".length, -".json".length);
        return runBytes.has(id) ? fileResponse(runBytes.get(id)) : respond(404, "");
      }
      if (agdrBytes.has(rel)) return fileResponse(agdrBytes.get(rel));
      return respond(404, "");
    }
    if (path === `${prefix}/pulls/7/reviews`) {
      const page = Number(parsed.searchParams.get("page") ?? "1");
      const headers = {};
      if (page < reviewPages.length) {
        const next = new URL(url);
        next.searchParams.set("page", String(page + 1));
        headers.link = `<${next.href}>; rel="next"`;
      }
      return respond(200, reviewPages[page - 1] ?? [], headers);
    }
    if (path === `${prefix}/pulls/7/commits`) {
      return respond(200, trailers.map((id, index) => ({
        sha: index === trailers.length - 1 ? HEAD : `${index.toString(16).padStart(40, "0")}`,
        commit: {
          message: `update files\n\nSee ApexYard-Run: ${MENTIONED}\n\nApexYard-Run: ${id}\n`,
          comment: POISON.commit,
        },
      })));
    }
    if (path === `${prefix}/pulls/7/files`) {
      return respond(200, agdr.map((file) => ({ filename: file.filename, status: file.status })));
    }
    if (path === "/graphql" && init.method === "POST") {
      return respond(200, {
        data: {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: linked.map((item) => ({
                  number: item.number,
                  state: item.state,
                  title: item.title,
                  repository: item.repository
                    ? { name: item.repository.name, owner: { login: item.repository.owner } }
                    : null,
                })),
              },
            },
          },
        },
      });
    }
    unexpected.push(url);
    return respond(500, "unexpected");
  }

  const temp = mkdtempSync(join(tmpdir(), "apexyard-gate-"));
  try {
    const eventPath = join(temp, "event.json");
    const summaryPath = join(temp, "summary.md");
    const outputPath = join(temp, "output.txt");
    const commands = [];
    writeFileSync(eventPath, JSON.stringify({
      number: 99,
      repository: {
        name: "apexyard-demo",
        owner: { login: "me2resh" },
        default_branch: "event-base",
      },
      pull_request: {
        number: 7,
        title: POISON.pr,
        body: POISON.body,
        state: "closed",
        head: { sha: DECOY, ref: "feature/GH-7-note" },
        base: { ref: "event-base", sha: DECOY },
      },
    }));
    const code = await run({
      INPUT_TOKEN: "test-token",
      "INPUT_APP-ID": "12345",
      "INPUT_APP-KEY": APP_KEY,
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_STEP_SUMMARY: summaryPath,
      GITHUB_OUTPUT: outputPath,
    }, {
      fetch: fetchImpl,
      pinnedKeys: { "test-pack-1": keys.pem },
      writeCommand: (line) => commands.push(line),
    });
    assert.deepEqual(unexpected, []);
    const created = calls.filter((call) => call.method === "POST" && call.path === `${prefix}/check-runs`);
    const updated = calls.filter((call) => call.method === "PATCH");
    assert.equal(created.length, 1);
    assert.equal(created[0].body.name, "ApexYard Gate");
    assert.equal(created[0].body.status, "in_progress");
    assert.equal(created[0].body.head_sha, HEAD);
    assert.match(created[0].body.started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(updated.length, 1);
    assert.equal(updated[0].body.status, "completed");
    assert.equal(updated[0].body.conclusion, fixture.expect.conclusion);
    assert.equal(updated[0].body.output.title, fixture.expect.title);
    assert.equal(updated.some((call) => call.body.conclusion === "success" && fixture.expect.conclusion !== "success"), false);
    const summary = updated[0].body.output.summary;
    assert.equal(code, fixture.expect.exitCode);
    assert.equal(readFileSync(outputPath, "utf8"), `verdict=${fixture.expect.verdict}\n`);
    assert.equal(readFileSync(summaryPath, "utf8"), `${summary}\n`);
    assert.equal(summary.includes("test-token"), false);
    assert.equal(summary.includes(APP_TOKEN), false);
    assert.equal(readFileSync(outputPath, "utf8").includes(APP_TOKEN), false);
    assert.equal(readFileSync(summaryPath, "utf8").includes(APP_TOKEN), false);
    const masks = commands.filter((line) => line.startsWith("::add-mask::"));
    assert.equal(masks.length, 2);
    assert.match(masks[0], /^::add-mask::[^.]+\.[^.]+\.[^.]+$/);
    assert.equal(masks[1], `::add-mask::${APP_TOKEN}`);
    assert.equal(commands.filter((line) => !line.startsWith("::add-mask::")).some((line) => line.includes(APP_TOKEN)), false);
    assert.equal(summary.includes(DECOY), false);
    assert.equal(summary.includes(STALE), false);
    for (const part of [POISON.issue, POISON.commit, POISON.agdr, POISON.pr, POISON.body, MENTIONED, ...(fixture.expect.summaryExcludes ?? [])]) {
      assert.equal(summary.includes(part), false, `found ${part}\n${summary}`);
    }
    for (const part of fixture.expect.summaryIncludes ?? []) {
      assert.equal(summary.includes(part), true, `missing ${part}\n${summary}`);
    }
    if (summary.startsWith("|")) {
      for (const line of summary.split("\n")) {
        if (!line.startsWith("|")) continue;
        assert.equal(countCells(line), 3, line);
      }
      const last = rowsFor(summary, "Last pusher");
      assert.equal(last.length, 1);
      assert.equal(last[0][1], "not checked");
      if (fixture.expect.conclusion === "success") {
        const packRows = rowsFor(summary, "Pack version, team and signature");
        assert.equal(packRows.length, 1, summary);
        assert.equal(packRows[0][1], "0.1.0 demo ok test-pack-1");
        assert.equal(packRows[0][2], "verified by signature");
      }
    }
    for (const expected of fixture.expect.rows ?? []) {
      const match = rowsFor(summary, expected.fact).find((cells) => cells[1] === expected.value && cells[2] === expected.label);
      assert.ok(match, `${expected.fact} missing\n${summary}`);
    }
    if (fixture.expect.requirePage2) assert.ok(calls.some((call) => call.url.includes("page=2")));
    const fetchedRunIds = contentFetches
      .filter((rel) => rel.startsWith("docs/runs/") && rel.endsWith(".json"))
      .map((rel) => rel.slice("docs/runs/".length, -".json".length));
    if (fixture.expect.fetchedRunIds) assert.deepEqual(fetchedRunIds, fixture.expect.fetchedRunIds);
    for (const id of fixture.expect.notFetchedRunIds ?? []) {
      assert.equal(fetchedRunIds.includes(id), false, id);
    }
    for (const rel of fixture.expect.notFetchedPaths ?? []) {
      assert.equal(contentFetches.includes(rel), false, rel);
    }
    if (fixture.expect.noApexyardContents) {
      assert.deepEqual(contentFetches.filter((rel) => rel.startsWith(".apexyard/")), []);
      assert.equal(calls.some((call) => call.path.includes("/contents/.apexyard")), false);
      for (const part of ["/pulls/7/reviews", "/pulls/7/commits", "/pulls/7/files", "/graphql"]) {
        assert.equal(calls.some((call) => call.path.includes(part)), false, part);
      }
      assert.deepEqual(contentFetches.filter((rel) => rel.startsWith("docs/")), []);
    }
    if (fixture.expect.maxAgdrFetches != null) {
      const fetched = contentFetches.filter((rel) => rel.startsWith("docs/agdr/"));
      assert.equal(fetched.length, fixture.expect.maxAgdrFetches);
    }
    if (fixture.expect.omittedAgdr != null) {
      assert.equal(rowsFor(summary, "AgDR files not read")[0][1], String(fixture.expect.omittedAgdr));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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

const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();

test("shell fixtures cover the required cases", () => {
  for (const name of required) assert.ok(files.includes(name), name);
});

for (const name of files) {
  test(name, async () => {
    const fixture = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
    await execute(fixture);
  });
}
