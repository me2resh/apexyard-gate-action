export function validateGate(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return "invalid gate.json";
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !Object.hasOwn(value, "v") || !Object.hasOwn(value, "approvers")) {
    return "invalid gate.json";
  }
  if (value.v !== 1) return "invalid gate.json";
  if (!Array.isArray(value.approvers) || value.approvers.length < 1) {
    return "invalid gate.json";
  }
  for (const id of value.approvers) {
    if (!Number.isSafeInteger(id) || id < 1) return "invalid gate.json";
  }
  return null;
}
