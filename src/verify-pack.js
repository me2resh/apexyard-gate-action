import { createVerify } from "node:crypto";

const PACK_SCHEMA = "apexyard.pack/0";
const VERSION_MAX_LENGTH = 64;
const RULE_ID_MAX_LENGTH = 66;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TEAM = /^[a-z0-9-]{1,32}$/;
const RULE_ID = /^AY-[A-Z0-9]+(-[A-Z0-9]+)*$/;
const CHECK = /^[a-z][a-z0-9-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function fail(kid, error) {
  return { ok: false, kid, version: null, team: null, pack: null, error };
}

function isBytes(value) {
  return value instanceof Uint8Array;
}

function ruleError(rule) {
  if (rule == null || typeof rule !== "object" || Array.isArray(rule)) return "invalid pack";
  const allowed = new Set(["id", "description", "enforcement", "check"]);
  for (const key of Object.keys(rule)) {
    if (!allowed.has(key)) return "invalid pack";
  }
  if (!Object.hasOwn(rule, "id")
    || !Object.hasOwn(rule, "description")
    || !Object.hasOwn(rule, "enforcement")
    || !Object.hasOwn(rule, "check")) {
    return "invalid pack";
  }
  if (typeof rule.id !== "string"
    || rule.id.length > RULE_ID_MAX_LENGTH
    || !RULE_ID.test(rule.id)) {
    return "invalid pack";
  }
  if (typeof rule.description !== "string"
    || Array.from(rule.description).length < 1
    || Array.from(rule.description).length > 280
    || CONTROL.test(rule.description)) {
    return "invalid pack";
  }
  if (rule.enforcement !== "blocking" && rule.enforcement !== "advisory") return "invalid pack";
  if (typeof rule.check !== "string" || !CHECK.test(rule.check)) return "invalid pack";
  return null;
}

export function packSchemaError(pack) {
  if (pack == null || typeof pack !== "object" || Array.isArray(pack)) return "invalid pack";
  if (Object.hasOwn(pack, "schema") && pack.schema !== PACK_SCHEMA) return "unsupported pack schema";
  const allowedTop = new Set(["schema", "version", "team", "rules"]);
  for (const key of Object.keys(pack)) {
    if (!allowedTop.has(key)) return "invalid pack";
  }
  if (!Object.hasOwn(pack, "schema")
    || !Object.hasOwn(pack, "version")
    || !Object.hasOwn(pack, "team")
    || !Object.hasOwn(pack, "rules")) {
    return "invalid pack";
  }
  if (typeof pack.version !== "string"
    || pack.version.length > VERSION_MAX_LENGTH
    || !VERSION.test(pack.version)) {
    return "invalid pack";
  }
  if (typeof pack.team !== "string" || !TEAM.test(pack.team)) return "invalid pack";
  if (!Array.isArray(pack.rules) || pack.rules.length < 1 || pack.rules.length > 100) return "invalid pack";
  const ids = new Set();
  for (const rule of pack.rules) {
    const error = ruleError(rule);
    if (error) return error;
    if (ids.has(rule.id)) return "invalid pack";
    ids.add(rule.id);
  }
  return null;
}

export function verifyPack(packBytes, sigFileBytes, pinnedKeys) {
  if (!isBytes(packBytes) || !isBytes(sigFileBytes) || pinnedKeys == null || typeof pinnedKeys !== "object" || Array.isArray(pinnedKeys)) {
    return fail(null, "invalid signature file");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(sigFileBytes).toString("utf8"));
  } catch {
    return fail(null, "invalid signature file");
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(null, "invalid signature file");
  }
  if (Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, "kid") || !Object.hasOwn(parsed, "sig")) {
    return fail(null, "invalid signature file");
  }
  if (typeof parsed.kid !== "string" || typeof parsed.sig !== "string" || parsed.kid === "" || parsed.sig === "") {
    return fail(typeof parsed.kid === "string" ? parsed.kid : null, "invalid signature file");
  }
  if (!Object.hasOwn(pinnedKeys, parsed.kid) || typeof pinnedKeys[parsed.kid] !== "string") {
    return fail(parsed.kid, "unknown kid");
  }
  let verified = false;
  try {
    const signature = Buffer.from(parsed.sig, "base64");
    const verifier = createVerify("SHA256");
    verifier.update(packBytes);
    verifier.end();
    verified = verifier.verify({ key: pinnedKeys[parsed.kid], dsaEncoding: "der" }, signature);
  } catch {
    return fail(parsed.kid, "bad signature");
  }
  if (!verified) return fail(parsed.kid, "bad signature");
  let pack;
  try {
    pack = JSON.parse(Buffer.from(packBytes).toString("utf8"));
  } catch {
    return fail(parsed.kid, "invalid pack json");
  }
  const schemaError = packSchemaError(pack);
  if (schemaError) return fail(parsed.kid, schemaError);
  return {
    ok: true,
    kid: parsed.kid,
    version: pack.version,
    team: pack.team,
    pack,
    error: null,
  };
}
