const RUN_ID = /^ayr-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const JOB_ID = /^ayj-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SLICE = /^slice-[a-z0-9][a-z0-9-]{0,79}$/;
const TOKEN = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const PACK_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const STAMP = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const AGDR_PATH = /^docs\/agdr\/AgDR-[A-Za-z0-9._+-]+\.md$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ENTRY = new Set(["runner-click", "github-label", "slack", "vendor-trigger"]);

function exact(value, keys) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const got = Object.keys(value);
  if (got.length !== keys.length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return false;
  }
  return true;
}

function integerId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateJob(job) {
  if (!exact(job, [
    "v",
    "job_id",
    "entry_point",
    "repo",
    "issue",
    "issue_body_sha256",
    "base",
    "slice_id",
    "harness",
    "mode",
    "model",
    "team",
    "requested_by",
    "signed_in_as",
    "requested_at",
  ])) return false;
  if (job.v !== 1) return false;
  if (typeof job.job_id !== "string" || !JOB_ID.test(job.job_id)) return false;
  if (!ENTRY.has(job.entry_point)) return false;
  if (!exact(job.repo, ["owner", "name"])) return false;
  if (typeof job.repo.owner !== "string" || !LOGIN.test(job.repo.owner)) return false;
  if (typeof job.repo.name !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(job.repo.name)) return false;
  if (job.repo.name.includes("..")) return false;
  if (!integerId(job.issue)) return false;
  if (typeof job.issue_body_sha256 !== "string" || !HEX64.test(job.issue_body_sha256)) return false;
  if (!exact(job.base, ["ref", "sha"])) return false;
  if (typeof job.base.ref !== "string" || !REF.test(job.base.ref) || job.base.ref.includes("..")) return false;
  if (typeof job.base.sha !== "string" || !SHA.test(job.base.sha)) return false;
  if (job.slice_id !== null && (typeof job.slice_id !== "string" || !SLICE.test(job.slice_id))) return false;
  if (typeof job.harness !== "string" || !TOKEN.test(job.harness)) return false;
  if (typeof job.mode !== "string" || !TOKEN.test(job.mode)) return false;
  if (typeof job.model !== "string" || !MODEL.test(job.model)) return false;
  if (!validateTeam(job.team)) return false;
  if (!exact(job.requested_by, ["github_id", "login", "source"])) return false;
  if (!integerId(job.requested_by.github_id)) return false;
  if (typeof job.requested_by.login !== "string" || !LOGIN.test(job.requested_by.login)) return false;
  if (typeof job.requested_by.source !== "string" || !TOKEN.test(job.requested_by.source)) return false;
  if (!validateSignedIn(job.signed_in_as)) return false;
  if (typeof job.requested_at !== "string" || !STAMP.test(job.requested_at)) return false;
  return true;
}

function validateTeam(team) {
  if (team === null) return true;
  if (!exact(team, ["id", "pack_version", "pack_sha256"])) return false;
  if (typeof team.id !== "string" || !TOKEN.test(team.id)) return false;
  if (typeof team.pack_version !== "string" || !PACK_VERSION.test(team.pack_version)) return false;
  if (typeof team.pack_sha256 !== "string" || !HEX64.test(team.pack_sha256)) return false;
  return true;
}

function validateSignedIn(value) {
  if (value === null) return true;
  if (!exact(value, ["github_id", "login"])) return false;
  if (!integerId(value.github_id)) return false;
  if (typeof value.login !== "string" || !LOGIN.test(value.login)) return false;
  return true;
}

export function validateRunRecord(value, expectedRunId) {
  if (!exact(value, [
    "v",
    "kind",
    "run_id",
    "job",
    "branch",
    "agdr_paths",
    "runner_version",
    "created_at",
  ])) return { ok: false };
  if (value.v !== 1) return { ok: false };
  if (value.kind !== "apexyard.run-record") return { ok: false };
  if (typeof value.run_id !== "string" || !RUN_ID.test(value.run_id)) return { ok: false };
  if (expectedRunId != null && value.run_id !== expectedRunId) return { ok: false };
  if (!validateJob(value.job)) return { ok: false };
  if (typeof value.branch !== "string" || !BRANCH.test(value.branch) || value.branch.includes("..")) {
    return { ok: false };
  }
  if (!Array.isArray(value.agdr_paths) || value.agdr_paths.length > 50) return { ok: false };
  for (const path of value.agdr_paths) {
    if (typeof path !== "string" || path.includes("..") || path.includes("`") || path.includes("\n")) {
      return { ok: false };
    }
    if (!AGDR_PATH.test(path)) return { ok: false };
  }
  if (typeof value.runner_version !== "string" || !VERSION.test(value.runner_version)) return { ok: false };
  if (typeof value.created_at !== "string" || !STAMP.test(value.created_at)) return { ok: false };
  return { ok: true };
}
