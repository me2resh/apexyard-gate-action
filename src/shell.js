import { readFileSync, appendFileSync } from "node:fs";
import { AppTokenError, createAppToken } from "./app-token.js";
import { evaluate } from "./evaluate.js";
import { createClient } from "./github.js";
import { PINNED_KEYS } from "./keys.js";
import { AGDR_MAX_BYTES, MAX_AGDR_FILES, MAX_RUN_RECORDS, RUN_RECORD_MAX_BYTES } from "./limits.js";
import { validateGate } from "./policy.js";
import { render } from "./render.js";
import { collectRunIds } from "./trailers.js";
import { verifyPack } from "./verify-pack.js";

export const CHECK_NAME = "ApexYard Gate";
const AGDR_NAME = /^docs\/agdr\/AgDR-[^/]+\.md$/;
const FILE_STATUSES = new Set(["added", "modified", "renamed", "copied", "changed"]);
const ALLOWED_EVENTS = new Set(["pull_request_target", "workflow_run"]);
const SHA = /^[0-9a-f]{40}$/;
const MAX_WORKFLOW_PULLS = 5;

function iso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function repositoryFrom(value) {
  const repository = value;
  if (!repository) throw new Error("missing repository");
  const owner = typeof repository.owner === "string" ? repository.owner : repository.owner && repository.owner.login;
  const name = repository.name;
  if (typeof owner !== "string" || owner.length === 0 || typeof name !== "string" || name.length === 0) {
    throw new Error("bad repository");
  }
  return { owner, name };
}

function repositoryFromEnvironment(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(value)) {
    throw new Error("bad GITHUB_REPOSITORY");
  }
  const [owner, name] = value.split("/");
  return { owner, name };
}

function targetFromEvent(event, eventName, githubRepository) {
  if (eventName === "workflow_run") {
    const workflowRun = event && event.workflow_run;
    const repository = repositoryFromEnvironment(githubRepository);
    const headSha = workflowRun && workflowRun.head_sha;
    if (typeof headSha !== "string" || !SHA.test(headSha)) throw new Error("bad workflow head sha");
    return { ...repository, headSha };
  }
  const repository = repositoryFrom(event && event.repository);
  const number = event && event.pull_request && Number.isInteger(event.pull_request.number)
    ? event.pull_request.number
    : event && event.number;
  if (!Number.isInteger(number) || number < 1) throw new Error("bad event");
  return { ...repository, number };
}

function writeOutputs(env, verdict, summary) {
  if (typeof env.GITHUB_STEP_SUMMARY === "string" && env.GITHUB_STEP_SUMMARY.length > 0) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  if (typeof env.GITHUB_OUTPUT === "string" && env.GITHUB_OUTPUT.length > 0) {
    appendFileSync(env.GITHUB_OUTPUT, `verdict=${verdict}\n`);
  }
}

function gateObject(file) {
  if (file.missing) return { ok: false, approvers: [], error: "missing gate.json" };
  let parsed;
  try {
    parsed = JSON.parse(file.bytes.toString("utf8"));
  } catch {
    return { ok: false, approvers: [], error: "invalid gate.json" };
  }
  const error = validateGate(parsed);
  if (error) return { ok: false, approvers: [], error };
  return { ok: true, approvers: parsed.approvers, error: null };
}

function packObject(packFile, sigFile, pinnedKeys) {
  if (packFile.missing) {
    return { ok: false, kid: null, version: null, team: null, pack: null, error: "missing pack" };
  }
  if (sigFile.missing) {
    return { ok: false, kid: null, version: null, team: null, pack: null, error: "unsigned pack" };
  }
  return verifyPack(packFile.bytes, sigFile.bytes, pinnedKeys);
}

function reviewState(review) {
  return {
    id: review.id,
    state: review.state,
    commit_id: review.commit_id,
    submitted_at: review.submitted_at,
    user: review.user
      ? { id: review.user.id, login: review.user.login, type: review.user.type }
      : null,
  };
}

async function loadRunRecords(client, owner, repo, headSha, commits) {
  const selected = collectRunIds(commits).ids.slice(0, MAX_RUN_RECORDS);
  const records = [];
  for (const runId of selected) {
    const file = await client.getFile(owner, repo, `docs/runs/${runId}.json`, headSha);
    if (file.missing) {
      records.push({ runId, status: "missing" });
      continue;
    }
    if (file.bytes.length > RUN_RECORD_MAX_BYTES || file.size > RUN_RECORD_MAX_BYTES) {
      records.push({ runId, status: "oversize" });
      continue;
    }
    let json;
    try {
      json = JSON.parse(file.bytes.toString("utf8"));
    } catch {
      records.push({ runId, status: "invalid" });
      continue;
    }
    records.push({ runId, status: "parsed", json });
  }
  return records;
}

async function loadAgdr(client, owner, repo, headSha, number) {
  const files = await client.listFiles(owner, repo, number);
  const changed = files
    .filter((file) => file && FILE_STATUSES.has(file.status) && typeof file.filename === "string" && AGDR_NAME.test(file.filename))
    .sort((left, right) => left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0);
  const chosen = changed.slice(0, MAX_AGDR_FILES);
  const agdrFiles = [];
  for (const file of chosen) {
    if (file.filename.includes("`") || file.filename.includes("\n") || file.filename.includes("\r") || file.filename.includes("..")) {
      agdrFiles.push({ path: file.filename, text: null });
      continue;
    }
    const body = await client.getFile(owner, repo, file.filename, headSha);
    if (body.missing || body.bytes.length > AGDR_MAX_BYTES || body.size > AGDR_MAX_BYTES) {
      agdrFiles.push({ path: file.filename, text: null });
      continue;
    }
    agdrFiles.push({ path: file.filename, text: body.bytes.toString("utf8") });
  }
  return { agdrFiles, agdrOmitted: changed.length - chosen.length };
}

function refusePull(pull, defaultBranch, id, detail) {
  const reason = { id, outcome: "fail", detail };
  return {
    verdict: "fail",
    reasons: [reason],
    evidence: {
      facts: [
        { fact: "Head SHA", kind: "sha", value: pull.headSha, label: "verified" },
        { fact: "Base ref", kind: "ref", value: pull.baseRef, label: "verified" },
        { fact: "Default branch", kind: "ref", value: defaultBranch, label: "verified" },
        {
          fact: "Last pusher",
          kind: "fixed",
          value: "not checked",
          label: "not checked by the gate. The ruleset checks it.",
        },
        { fact: "Rule", kind: "rule", value: reason, label: "blocking" },
      ],
    },
  };
}

async function evaluatePull(client, owner, repo, pull, pinnedKeys) {
  const defaultBranch = await client.getDefaultBranch(owner, repo);
  if (pull.baseRef !== defaultBranch) {
    return refusePull(pull, defaultBranch, "AY-GATE-BASE", "PR base is not the default branch");
  }
  if (pull.state !== "open") {
    return refusePull(pull, defaultBranch, "AY-GATE-OPEN", "PR is not open");
  }
  const baseSha = await client.getBranchSha(owner, repo, defaultBranch);
  const packFile = await client.getFile(owner, repo, ".apexyard/pack.json", baseSha);
  const sigFile = await client.getFile(owner, repo, ".apexyard/pack.json.sig", baseSha);
  const gateFile = await client.getFile(owner, repo, ".apexyard/gate.json", baseSha);
  const reviews = (await client.listReviews(owner, repo, pull.number)).map(reviewState);
  const commits = (await client.listCommits(owner, repo, pull.number)).map((commit) => ({
    sha: commit.sha,
    message: commit.commit && commit.commit.message,
  }));
  const linkedIssues = await client.closingIssues(owner, repo, pull.number);
  const runRecords = await loadRunRecords(client, owner, repo, pull.headSha, commits);
  const agdr = await loadAgdr(client, owner, repo, pull.headSha, pull.number);
  const policy = {
    baseSha,
    pack: packObject(packFile, sigFile, pinnedKeys),
    gate: gateObject(gateFile),
  };
  const pr = {
    repository: { owner, name: repo },
    number: pull.number,
    author: pull.author,
    headSha: pull.headSha,
    base: { ref: defaultBranch, sha: baseSha },
    reviews,
    linkedIssues,
    commits,
    runRecords,
    agdrFiles: agdr.agdrFiles,
    agdrOmitted: agdr.agdrOmitted,
  };
  return evaluate(policy, pr);
}

function clockDate(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("bad clock");
  return date;
}

function emitError(writeCommand, message) {
  writeCommand(`::error::ApexYard Gate: ${message}`);
}

function emitResolutionLogs(writeCommand, messages) {
  for (const message of messages) writeCommand(`::notice::ApexYard Gate: ${message}`);
}

async function resolvePulls(client, target, eventName) {
  if (eventName === "pull_request_target") {
    return { pulls: [await client.getPull(target.owner, target.name, target.number)], messages: [] };
  }

  const candidates = await client.listPullsForCommit(target.owner, target.name, target.headSha);
  const numbers = [];
  const seen = new Set();
  const messages = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.number)) continue;
    seen.add(candidate.number);
    if (candidate.state !== "open") {
      messages.push(`skipped pull request #${candidate.number} because it is not open`);
      continue;
    }
    numbers.push(candidate.number);
  }

  const openPulls = [];
  for (const number of numbers) {
    const pull = await client.getPull(target.owner, target.name, number);
    if (pull.state !== "open") {
      messages.push(`skipped pull request #${number} because it is no longer open`);
      continue;
    }
    openPulls.push(pull);
  }

  const matching = openPulls.find((pull) => pull.headSha === target.headSha);
  const prioritized = matching
    ? [matching, ...openPulls.filter((pull) => pull.number !== matching.number)]
    : openPulls;
  const pulls = prioritized.slice(0, MAX_WORKFLOW_PULLS);
  const selected = new Set(pulls.map((pull) => pull.number));
  for (const pull of openPulls) {
    if (!selected.has(pull.number)) {
      messages.push(`dropped pull request #${pull.number} because the limit is ${MAX_WORKFLOW_PULLS}`);
    }
  }
  return { pulls, messages };
}

function combinedSummary(results) {
  if (results.length === 1) return results[0].summary;
  return results.map((result) => `## Pull request #${result.number}\n\n${result.summary}`).join("\n\n");
}

export async function run(env, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const pinnedKeys = deps.pinnedKeys ?? PINNED_KEYS;
  const clientFactory = deps.createClient ?? createClient;
  const mintAppToken = deps.createAppToken ?? createAppToken;
  const evaluatePullImpl = deps.evaluatePull ?? evaluatePull;
  const clock = deps.clock ?? Date.now;
  const writeCommand = deps.writeCommand ?? ((line) => console.log(line));
  let active = null;
  try {
    const eventName = env.GITHUB_EVENT_NAME;
    if (!ALLOWED_EVENTS.has(eventName)) {
      emitError(writeCommand, "event must be pull_request_target or workflow_run");
      return 1;
    }
    const token = env.INPUT_TOKEN;
    if (typeof token !== "string" || token.length === 0) throw new Error("missing token");
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const target = targetFromEvent(event, eventName, env.GITHUB_REPOSITORY);
    const readClient = clientFactory({ token, fetchImpl });
    const defaultBranch = await readClient.getDefaultBranch(target.owner, target.name);
    if (env.GITHUB_REF !== `refs/heads/${defaultBranch}`) {
      emitError(writeCommand, "GITHUB_REF must be the default branch");
      return 1;
    }

    const resolution = await resolvePulls(readClient, target, eventName);
    if (resolution.pulls.length === 0) {
      emitResolutionLogs(writeCommand, resolution.messages);
      return 0;
    }

    let appToken;
    try {
      appToken = await mintAppToken({
        appId: env["INPUT_APP-ID"],
        appKey: env["INPUT_APP-KEY"],
        owner: target.owner,
        repo: target.name,
      }, {
        clock,
        fetchImpl,
        createClient: clientFactory,
        maskToken: (value) => writeCommand(`::add-mask::${value}`),
      });
    } catch (error) {
      const message = error instanceof AppTokenError ? error.message : "App token creation failed";
      emitError(writeCommand, message);
      return 1;
    }

    const checkClient = clientFactory({ token: appToken, fetchImpl });
    emitResolutionLogs(writeCommand, resolution.messages);
    const results = [];
    let exitCode = 0;
    for (const pull of resolution.pulls) {
      active = { client: checkClient, owner: target.owner, repo: target.name, check: null };
      active.check = await checkClient.createCheck(target.owner, target.name, {
        name: CHECK_NAME,
        head_sha: pull.headSha,
        status: "in_progress",
        started_at: iso(clockDate(clock)),
      });
      const result = await evaluatePullImpl(readClient, target.owner, target.name, pull, pinnedKeys);
      const summary = render(result.evidence);
      const conclusion = result.verdict === "pass" ? "success" : "failure";
      await checkClient.updateCheck(target.owner, target.name, active.check.id, {
        status: "completed",
        conclusion,
        completed_at: iso(clockDate(clock)),
        output: { title: result.verdict, summary },
      });
      active = null;
      results.push({ number: pull.number, verdict: result.verdict, summary });
      if (result.verdict !== "pass") exitCode = 1;
    }
    const verdict = exitCode === 0 ? "pass" : "fail";
    writeOutputs(env, verdict, combinedSummary(results));
    return exitCode;
  } catch {
    try {
      if (active && active.check) {
        await active.client.updateCheck(active.owner, active.repo, active.check.id, {
          status: "completed",
          conclusion: "failure",
          completed_at: iso(clockDate(clock)),
          output: { title: "gate error", summary: "gate error" },
        });
      }
    } catch {
      // The job still fails when the failure update fails.
    }
    emitError(writeCommand, "gate execution failed");
    try {
      writeOutputs(env, "error", "gate error");
    } catch {
      // Ignore output errors after a gate error.
    }
    return 1;
  }
}
