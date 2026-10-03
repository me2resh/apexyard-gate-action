export const PACK_RESULTS = new Set([
  "ok",
  "missing pack",
  "unsigned pack",
  "bad signature",
  "unknown kid",
  "unsupported pack schema",
  "invalid pack",
  "invalid signature file",
  "invalid pack json",
]);

export const RULE_DETAILS = new Set([
  "open linked issue",
  "no open linked issue in this repository",
  "approved on the head sha",
  "no qualifying approval",
  "unknown check",
  "missing pack",
  "unsigned pack",
  "bad signature",
  "unknown kid",
  "unsupported pack schema",
  "invalid pack",
  "invalid signature file",
  "invalid pack json",
  "missing gate.json",
  "invalid gate.json",
  "required rule missing",
  "PR base is not the default branch",
  "PR is not open",
]);

export const RULE_OUTCOMES = new Set(["pass", "fail", "not evaluated"]);

export function packResult(error) {
  if (PACK_RESULTS.has(error)) return error;
  return "invalid pack";
}
