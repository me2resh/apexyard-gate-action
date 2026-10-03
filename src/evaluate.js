import { runLinkFromAgdr } from "./agdr.js";
import { MAX_RUN_RECORDS } from "./limits.js";
import { packResult } from "./phrases.js";
import { collectRunIds } from "./trailers.js";
import { validateRunRecord } from "./validate-record.js";

const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

function stamp(review) {
  const value = review && typeof review.submitted_at === "string" ? review.submitted_at : "";
  return ISO.test(value) ? value : "";
}

function later(left, right) {
  const leftStamp = stamp(left);
  const rightStamp = stamp(right);
  if (leftStamp !== rightStamp) return leftStamp > rightStamp;
  return (left.id ?? 0) > (right.id ?? 0);
}

function sameRepo(issue, pr) {
  const owner = issue.repository && issue.repository.owner;
  const name = issue.repository && issue.repository.name;
  if (typeof owner !== "string" || typeof name !== "string") return false;
  return owner.toLowerCase() === pr.repository.owner.toLowerCase()
    && name.toLowerCase() === pr.repository.name.toLowerCase();
}

function linkedTicket(pr) {
  const issues = Array.isArray(pr.linkedIssues) ? pr.linkedIssues : [];
  const numbers = [];
  for (const issue of issues) {
    if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1) continue;
    if (!sameRepo(issue, pr)) continue;
    if (String(issue.state ?? "").toUpperCase() !== "OPEN") continue;
    if (!numbers.includes(issue.number)) numbers.push(issue.number);
  }
  if (numbers.length === 0) {
    return { outcome: "fail", detail: "no open linked issue in this repository", numbers: [] };
  }
  return { outcome: "pass", detail: "open linked issue", numbers };
}

function latestByReviewer(reviews) {
  const byUser = new Map();
  const list = Array.isArray(reviews) ? reviews : [];
  for (const review of list) {
    if (!review || review.user == null || typeof review.user !== "object") continue;
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    if (!Number.isSafeInteger(review.user.id)) continue;
    const previous = byUser.get(review.user.id);
    if (!previous || later(review, previous)) byUser.set(review.user.id, review);
  }
  return [...byUser.values()];
}

function qualifyingApprovals(pr, approvers) {
  const allow = new Set(approvers);
  const found = [];
  for (const review of latestByReviewer(pr.reviews)) {
    if (review.state !== "APPROVED") continue;
    if (review.commit_id !== pr.headSha) continue;
    if (!allow.has(review.user.id)) continue;
    if (review.user.type !== "User") continue;
    if (review.user.id === pr.author.id) continue;
    found.push(review);
  }
  return found;
}

function approvalReason(policy, pr) {
  if (!policy.gate || !policy.gate.ok) {
    const detail = policy.gate && policy.gate.error === "missing gate.json"
      ? "missing gate.json"
      : "invalid gate.json";
    return { id: "approval", outcome: "fail", detail };
  }
  const found = qualifyingApprovals(pr, policy.gate.approvers);
  if (found.length === 0) {
    return { id: "approval", outcome: "fail", detail: "no qualifying approval" };
  }
  return { id: "approval", outcome: "pass", detail: "approved on the head sha" };
}

function ruleReasons(policy, pr) {
  const reasons = [];
  if (!policy.pack || !policy.pack.ok) {
    reasons.push({
      id: "pack",
      outcome: "fail",
      detail: packResult(policy.pack && policy.pack.error),
    });
    return reasons;
  }
  let sawTicket = false;
  for (const rule of policy.pack.pack.rules) {
    if (rule.check === "linked-ticket") {
      sawTicket = true;
      const ticket = linkedTicket(pr);
      reasons.push({ id: rule.id, outcome: ticket.outcome, detail: ticket.detail });
    } else if (rule.enforcement === "advisory") {
      reasons.push({ id: rule.id, outcome: "not evaluated", detail: "unknown check" });
    } else {
      reasons.push({ id: rule.id, outcome: "fail", detail: "unknown check" });
    }
  }
  if (!sawTicket) {
    reasons.push({ id: "AY-TICKET-001", outcome: "fail", detail: "required rule missing" });
  }
  return reasons;
}

function recordById(pr) {
  const map = new Map();
  const records = Array.isArray(pr.runRecords) ? pr.runRecords : [];
  for (const record of records) {
    if (record && typeof record.runId === "string" && !map.has(record.runId)) {
      map.set(record.runId, record);
    }
  }
  return map;
}

function buildEvidence(policy, pr, reasons) {
  const facts = [];
  facts.push({ fact: "Head SHA", kind: "sha", value: pr.headSha, label: "verified" });
  facts.push({ fact: "Base SHA", kind: "sha", value: policy.baseSha, label: "verified" });
  const pack = policy.pack ?? {
    ok: false,
    error: "missing pack",
    kid: null,
    version: null,
    team: null,
  };
  facts.push({
    fact: "Pack version, team and signature",
    kind: "pack",
    value: {
      version: pack.ok ? pack.version : null,
      team: pack.ok ? pack.team : null,
      result: pack.ok ? "ok" : packResult(pack.error),
      kid: typeof pack.kid === "string" ? pack.kid : null,
    },
    label: "verified by signature",
  });
  const ticket = linkedTicket(pr);
  facts.push({ fact: "Linked ticket", kind: "tickets", value: ticket.numbers, label: "verified" });
  const approvers = policy.gate && policy.gate.ok ? qualifyingApprovals(pr, policy.gate.approvers) : [];
  if (approvers.length === 0) {
    facts.push({ fact: "Approver", kind: "fixed", value: "none", label: "verified" });
  } else {
    for (const review of approvers) {
      facts.push({
        fact: "Approver",
        kind: "approver",
        value: {
          login: review.user.login,
          id: review.user.id,
          reviewId: review.id,
          commitId: review.commit_id,
        },
        label: "verified",
      });
    }
  }
  facts.push({
    fact: "PR author",
    kind: "author",
    value: { login: pr.author.login, id: pr.author.id },
    label: "verified",
  });
  facts.push({
    fact: "Last pusher",
    kind: "fixed",
    value: "not checked",
    label: "not checked by the gate. The ruleset checks it.",
  });
  const trailers = collectRunIds(pr.commits);
  const selected = trailers.ids.slice(0, MAX_RUN_RECORDS);
  facts.push({
    fact: "Run trailers",
    kind: "trailer-count",
    value: { left: trailers.withTrailer, right: trailers.commitCount },
    label: "reported",
  });
  facts.push({
    fact: "Run ids",
    kind: "run-count",
    value: { left: selected.length, right: trailers.ids.length },
    label: "reported",
  });
  const records = recordById(pr);
  for (const runId of selected) {
    const record = records.get(runId);
    if (!record || record.status !== "parsed") {
      facts.push({
        fact: "Run record",
        kind: "record",
        value: { runId, state: "not reported" },
        label: "reported",
      });
      continue;
    }
    const valid = validateRunRecord(record.json, runId);
    if (!valid.ok) {
      facts.push({
        fact: "Run record",
        kind: "record",
        value: { runId, state: "not reported" },
        label: "reported",
      });
      continue;
    }
    facts.push({
      fact: "ORBIT slice",
      kind: "slice",
      value: { runId, sliceId: record.json.job.slice_id },
      label: "reported",
    });
    facts.push({
      fact: "Harness, mode and model",
      kind: "catalogue",
      value: {
        runId,
        harness: record.json.job.harness,
        mode: record.json.job.mode,
        model: record.json.job.model,
      },
      label: "reported",
    });
  }
  const agdrs = Array.isArray(pr.agdrFiles) ? pr.agdrFiles : [];
  for (const file of agdrs) {
    facts.push({ fact: "AgDR path", kind: "path", value: file.path, label: "presence verified" });
    const link = typeof file.text === "string" ? runLinkFromAgdr(file.text) : null;
    facts.push({
      fact: "AgDR run link",
      kind: "run-id",
      value: link,
      label: "reported",
    });
  }
  if (Number.isSafeInteger(pr.agdrOmitted) && pr.agdrOmitted > 0) {
    facts.push({
      fact: "AgDR files not read",
      kind: "count",
      value: pr.agdrOmitted,
      label: "presence verified",
    });
  }
  for (const reason of reasons) {
    const label = reason.outcome === "not evaluated"
      ? "advisory"
      : reason.outcome === "fail"
        ? "blocking"
        : "verified";
    facts.push({
      fact: "Rule",
      kind: "rule",
      value: { id: reason.id, outcome: reason.outcome, detail: reason.detail },
      label,
    });
  }
  return { facts };
}

export function evaluate(policy, pr) {
  const reasons = [...ruleReasons(policy, pr), approvalReason(policy, pr)];
  const verdict = reasons.some((reason) => reason.outcome === "fail") ? "fail" : "pass";
  const evidence = buildEvidence(policy, pr, reasons);
  return { verdict, reasons, evidence };
}
