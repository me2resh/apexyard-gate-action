import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function scriptBodies(text) {
  const lines = text.split(/\r?\n/);
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^([ ]*)(run|script):(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const marker = match[3].trim();
    if (marker === "|" || marker === ">" || marker.startsWith("|") || marker.startsWith(">")) {
      const block = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j];
        if (line.trim() === "") {
          block.push("");
          continue;
        }
        if (line.match(/^ */)[0].length <= indent) break;
        block.push(line);
      }
      bodies.push(block.join("\n"));
    } else {
      bodies.push(match[3]);
    }
  }
  return bodies;
}

function permissions(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "permissions:");
  assert.ok(start >= 0);
  const found = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lines[i].match(/^ {2}([A-Za-z0-9-]+): (.+)$/);
    if (!match) break;
    found[match[1]] = match[2].trim();
  }
  return found;
}

function jobNames(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "jobs:");
  assert.ok(start >= 0);
  return lines.slice(start + 1)
    .map((line) => line.match(/^ {2}([A-Za-z0-9-]+):$/))
    .filter(Boolean)
    .map((match) => match[1]);
}

test("the workflow template follows the gate rules", () => {
  const fixture = JSON.parse(read("test/fixtures/template/template-rules.json"));
  const text = read(fixture.file);
  const relay = read(fixture.relayFile);
  const lines = text.split(/\r?\n/);
  for (const line of fixture.mustInclude) assert.ok(lines.includes(line), line);
  for (const snippet of fixture.mustNotInclude) assert.equal(text.includes(snippet), false, snippet);
  assert.deepEqual(permissions(text), fixture.permissions);
  const uses = [...text.matchAll(/^[ ]*uses:[ ]*(\S+)/gm)].map((match) => match[1]);
  assert.deepEqual(uses, [fixture.uses]);
  const pin = fixture.uses.split("@")[1];
  assert.match(pin, /^[0-9a-f]{40}$/);
  assert.equal(text.includes(`name: ${fixture.forbiddenJobName}`), false);
  assert.equal(lines.filter((line) => line.trim() === `${fixture.jobName}:`).length, 1);
  const eventLines = lines.filter((line) => line.includes("${{ github.event"));
  assert.deepEqual(eventLines, [
    "  group: apexyard-gate-${{ github.event.pull_request.number || github.event.workflow_run.head_sha }}",
  ]);
  for (const body of scriptBodies(text)) {
    assert.equal(body.includes("${{ github.event"), false, body);
    assert.equal(body.includes("github.head_ref"), false, body);
  }
  assert.equal(scriptBodies(text).length, 0);
  for (const [event, types] of Object.entries(fixture.triggers)) {
    assert.equal(text.includes(`${event}:`), true);
    assert.equal(text.includes(`types: [${types.join(", ")}]`), true);
  }
  assert.equal(text.includes("pull_request_review:"), false);
  assert.equal(text.includes("conclusion"), false);
  assert.deepEqual(lines.filter((line) => line.trim().startsWith("environment:")), [
    "    environment: apexyard-gate",
  ]);
  assert.deepEqual(jobNames(text), [fixture.jobName]);
  assert.equal(text.includes(": write"), false);
  const secretReferences = [...text.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)]
    .map((match) => match[1]);
  assert.deepEqual(secretReferences, ["APEXYARD_GATE_APP_ID", "APEXYARD_GATE_APP_KEY"]);
  assert.equal(relay.includes("environment:"), false);
  assert.equal(relay.includes("secrets."), false);
  assert.equal(relay.includes("actions/checkout"), false);
  assert.equal(text.includes("actions/checkout"), false);
  assert.match(relay, /^name: apexyard-gate-relay$/m);
  assert.match(relay, /^  pull_request_review:$/m);
  assert.match(relay, /^    types: \[submitted, edited, dismissed\]$/m);
  assert.match(relay, /^permissions: \{\}$/m);
  assert.deepEqual(jobNames(relay), ["relay"]);
  assert.deepEqual(scriptBodies(relay), [" echo relay"]);
});

test("repository CI runs the tests on Node 24", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /pull_request:/);
  assert.match(ci, /push:/);
  assert.match(ci, /- main/);
  assert.match(ci, /contents: read/);
  assert.equal(ci.includes("checks: write"), false);
  assert.match(ci, /node-version: "24"/);
  assert.match(ci, /node --test --experimental-test-coverage/);
});

test("the action entry points at the source", () => {
  const action = read("action.yml");
  assert.match(action, /using: node24/);
  assert.match(action, /main: dist\/index\.js/);
  assert.match(action, /token:/);
  assert.match(action, /app-id:/);
  assert.match(action, /app-key:/);
  assert.equal((action.match(/required: true/g) ?? []).length, 3);
  assert.match(action, /verdict:/);
  assert.match(read("dist/index.js"), /import "\.\.\/src\/main\.js"/);
  assert.match(read("package.json"), /"type": "module"/);
});
