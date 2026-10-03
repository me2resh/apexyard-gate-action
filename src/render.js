import { SUMMARY_MAX_CHARS } from "./limits.js";
import { PACK_RESULTS, RULE_DETAILS, RULE_OUTCOMES } from "./phrases.js";

const SHA = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SLICE = /^slice-[a-z0-9][a-z0-9-]{0,79}$/;
const RUN_ID = /^ayr-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const VERSION_MAX_LENGTH = 64;
const RULE_ID_MAX_LENGTH = 66;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TEAM = /^[a-z0-9-]{1,32}$/;
const KID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PATH = /^docs\/agdr\/AgDR-[A-Za-z0-9._|+-]+\.md$/;
const PACK_RULE_ID = /^AY-[A-Z0-9]+(-[A-Z0-9]+)*$/;
const BUILT_IN_RULE_IDS = new Set(["pack", "approval"]);
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

const FACTS = new Set([
  "Head SHA",
  "Base ref",
  "Default branch",
  "Base SHA",
  "Pack version, team and signature",
  "Linked ticket",
  "Approver",
  "PR author",
  "Last pusher",
  "Run trailers",
  "Run ids",
  "Run record",
  "ORBIT slice",
  "Harness, mode and model",
  "AgDR path",
  "AgDR run link",
  "AgDR files not read",
  "Rule",
]);

const LABELS = new Set([
  "verified",
  "verified by signature",
  "reported",
  "presence verified",
  "not checked by the gate. The ruleset checks it.",
  "advisory",
  "blocking",
]);

function escapeCell(text) {
  return String(text).replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ");
}

function rowLine(cells) {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function integerOk(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function formatAuthor(value, withReview) {
  if (!value || typeof value !== "object") return "(refused)";
  if (!integerOk(value.id)) return "(refused)";
  const loginOk = typeof value.login === "string" && LOGIN.test(value.login);
  if (withReview) {
    if (!integerOk(value.reviewId) || typeof value.commitId !== "string" || !SHA.test(value.commitId)) {
      return "(refused)";
    }
    if (!loginOk) return `${value.id} ${value.reviewId} ${value.commitId}`;
    return `${value.login} ${value.id} ${value.reviewId} ${value.commitId}`;
  }
  if (!loginOk) return String(value.id);
  return `${value.login} ${value.id}`;
}

function formatPack(value) {
  if (!value || typeof value !== "object") return "(refused)";
  if (!PACK_RESULTS.has(value.result)) return "(refused)";
  const parts = [];
  if (value.version != null) {
    if (typeof value.version !== "string"
      || value.version.length > VERSION_MAX_LENGTH
      || !VERSION.test(value.version)) {
      return "(refused)";
    }
    parts.push(value.version);
  }
  if (value.team != null) {
    if (typeof value.team !== "string" || !TEAM.test(value.team)) return "(refused)";
    parts.push(value.team);
  }
  parts.push(value.result);
  if (typeof value.kid === "string" && KID.test(value.kid)) parts.push(value.kid);
  return parts.join(" ");
}

function formatTickets(value) {
  if (!Array.isArray(value) || value.length === 0) return "none";
  const numbers = [];
  for (const number of value) {
    if (!integerOk(number)) return "(refused)";
    numbers.push(String(number));
  }
  return numbers.join(", ");
}

function formatPath(value) {
  if (typeof value !== "string") return "(refused)";
  if (value.includes("`") || value.includes("\n") || value.includes("\r") || value.includes("..")) {
    return "(refused)";
  }
  if (!PATH.test(value)) return "(refused)";
  return `\`${value}\``;
}

function formatCountPair(value, suffix) {
  if (!value || typeof value !== "object") return "(refused)";
  const left = value.left;
  const right = value.right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return "(refused)";
  if (left < 0 || right < 0 || left > right) return "(refused)";
  return `${left} of ${right} ${suffix}`;
}

function formatSlice(value) {
  if (!value || typeof value !== "object") return "(refused)";
  if (typeof value.runId !== "string" || !RUN_ID.test(value.runId)) return "(refused)";
  if (value.sliceId == null) return `${value.runId} none`;
  if (typeof value.sliceId !== "string" || !SLICE.test(value.sliceId)) return "(refused)";
  return `${value.runId} ${value.sliceId}`;
}

function formatCatalogue(value) {
  if (!value || typeof value !== "object") return "(refused)";
  if (typeof value.runId !== "string" || !RUN_ID.test(value.runId)) return "(refused)";
  if (typeof value.harness !== "string" || !TOKEN.test(value.harness)) return "(refused)";
  if (typeof value.mode !== "string" || !TOKEN.test(value.mode)) return "(refused)";
  if (typeof value.model !== "string" || !MODEL.test(value.model)) return "(refused)";
  return `${value.runId} ${value.harness} ${value.mode} ${value.model}`;
}

function formatRecord(value) {
  if (!value || typeof value !== "object") return "(refused)";
  if (typeof value.runId !== "string" || !RUN_ID.test(value.runId)) return "(refused)";
  if (value.state !== "not reported" && value.state !== "not read") return "(refused)";
  return `${value.runId} ${value.state}`;
}

function formatRule(value) {
  if (!value || typeof value !== "object") return "(refused)";
  if (typeof value.id !== "string"
    || value.id.length > RULE_ID_MAX_LENGTH
    || (!BUILT_IN_RULE_IDS.has(value.id) && !PACK_RULE_ID.test(value.id))) {
    return "(refused)";
  }
  if (!RULE_OUTCOMES.has(value.outcome)) return "(refused)";
  if (!RULE_DETAILS.has(value.detail)) return "(refused)";
  return `${value.id} ${value.outcome} ${value.detail}`;
}

function formatRunId(value) {
  if (value == null) return "not reported";
  if (typeof value !== "string" || !RUN_ID.test(value)) return "(refused)";
  return value;
}

function formatSha(value) {
  if (typeof value !== "string" || !SHA.test(value)) return "(refused)";
  return value;
}

function formatRef(value) {
  if (typeof value !== "string" || !REF.test(value) || value.includes("..")) return "(refused)";
  return value;
}

function formatCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) return "(refused)";
  return String(value);
}

function formatFixed(value) {
  if (value === "none" || value === "not checked") return value;
  return "(refused)";
}

function formatFact(fact) {
  switch (fact.kind) {
    case "sha":
      return formatSha(fact.value);
    case "ref":
      return formatRef(fact.value);
    case "pack":
      return formatPack(fact.value);
    case "tickets":
      return formatTickets(fact.value);
    case "approver":
      return formatAuthor(fact.value, true);
    case "author":
      return formatAuthor(fact.value, false);
    case "fixed":
      return formatFixed(fact.value);
    case "trailer-count":
      return formatCountPair(fact.value, "commits carry the trailer");
    case "run-count":
      return formatCountPair(fact.value, "run ids read");
    case "record":
      return formatRecord(fact.value);
    case "slice":
      return formatSlice(fact.value);
    case "catalogue":
      return formatCatalogue(fact.value);
    case "path":
      return formatPath(fact.value);
    case "run-id":
      return formatRunId(fact.value);
    case "count":
      return formatCount(fact.value);
    case "rule":
      return formatRule(fact.value);
    default:
      return "(refused)";
  }
}

function cap(text) {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  const note = "\n\n(truncated)";
  return text.slice(0, SUMMARY_MAX_CHARS - note.length) + note;
}

export function render(evidence) {
  const facts = evidence && Array.isArray(evidence.facts) ? evidence.facts : [];
  const lines = ["| Fact | Value | Label |", "| --- | --- | --- |"];
  for (const fact of facts) {
    if (!fact || typeof fact !== "object") continue;
    if (!FACTS.has(fact.fact) || !LABELS.has(fact.label)) continue;
    lines.push(rowLine([fact.fact, formatFact(fact), fact.label]));
  }
  return cap(lines.join("\n"));
}
