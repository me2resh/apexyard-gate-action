import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/shell.js";

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const HEAD = "a".repeat(40);
const APP_TOKEN = "ghs_identity-test-token";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_KEY = privateKey.export({ type: "pkcs8", format: "pem" });

function tempEvent(event) {
  const temp = mkdtempSync(join(tmpdir(), "apexyard-identity-"));
  const eventPath = join(temp, "event.json");
  writeFileSync(eventPath, JSON.stringify(event));
  return {
    temp,
    eventPath,
    outputPath: join(temp, "output.txt"),
    summaryPath: join(temp, "summary.md"),
  };
}

function pull(number = 7, state = "open") {
  return {
    number,
    headSha: number === 7 ? HEAD : number.toString(16).padStart(40, "0"),
    baseRef: "main",
    state,
    author: { id: 111, login: "author", type: "User" },
  };
}

function pullEvent() {
  return {
    number: 7,
    repository: { name: "apexyard-demo", owner: { login: "me2resh" } },
    pull_request: { number: 7, head: { sha: "d".repeat(40) } },
  };
}

function baseEnv(paths, overrides = {}) {
  return {
    INPUT_TOKEN: "job-token",
    "INPUT_APP-ID": "12345",
    "INPUT_APP-KEY": APP_KEY,
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "me2resh/apexyard-demo",
    GITHUB_EVENT_PATH: paths.eventPath,
    GITHUB_OUTPUT: paths.outputPath,
    GITHUB_STEP_SUMMARY: paths.summaryPath,
    ...overrides,
  };
}

for (const step of ["JWT creation", "installation lookup", "token request"]) {
  test(`${step} failure emits one error line and creates no check`, async () => {
    const paths = tempEvent(pullEvent());
    const commands = [];
    let checks = 0;
    try {
      const code = await run(baseEnv(paths, step === "JWT creation" ? { "INPUT_APP-KEY": "bad key" } : {}), {
        clock: () => NOW,
        writeCommand: (line) => commands.push(line),
        createClient: ({ token }) => {
          if (token === "job-token") {
            return {
              getDefaultBranch: async () => "main",
              getPull: async () => pull(),
            };
          }
          if (token === APP_TOKEN) {
            return {
              createCheck: async () => { checks += 1; },
            };
          }
          return {
            getInstallation: async () => {
              if (step === "installation lookup") throw new Error("installation secret detail");
              return 808;
            },
            createInstallationToken: async () => {
              if (step === "token request") throw new Error("ghs_secret-detail");
              return APP_TOKEN;
            },
          };
        },
      });
      assert.equal(code, 1);
      assert.equal(checks, 0);
      assert.deepEqual(
        commands.filter((line) => line.startsWith("::error::")),
        [`::error::ApexYard Gate: ${step} failed`],
      );
      const masks = commands.filter((line) => line.startsWith("::add-mask::"));
      assert.equal(masks.length, step === "JWT creation" ? 0 : 1);
      if (masks.length === 1) assert.match(masks[0], /^::add-mask::[^.]+\.[^.]+\.[^.]+$/);
      assert.equal(existsSync(paths.outputPath), false);
      assert.equal(existsSync(paths.summaryPath), false);
      assert.equal(commands.some((line) => line.includes("secret-detail")), false);
    } finally {
      rmSync(paths.temp, { recursive: true, force: true });
    }
  });
}

test("refuses every event other than pull_request_target or workflow_run", async () => {
  for (const eventName of ["push", "pull_request", "pull_request_review", "workflow_dispatch", ""]) {
    const paths = tempEvent(pullEvent());
    const commands = [];
    let clients = 0;
    try {
      const code = await run(baseEnv(paths, { GITHUB_EVENT_NAME: eventName }), {
        writeCommand: (line) => commands.push(line),
        createClient: () => { clients += 1; throw new Error("must not create a client"); },
      });
      assert.equal(code, 1, eventName);
      assert.equal(clients, 0, eventName);
      assert.deepEqual(commands, [
        "::error::ApexYard Gate: event must be pull_request_target or workflow_run",
      ]);
    } finally {
      rmSync(paths.temp, { recursive: true, force: true });
    }
  }
});

test("refuses allowed events unless GITHUB_REF is the default branch", async () => {
  for (const ref of ["refs/heads/feature", "refs/tags/main", "refs/pull/7/merge", ""]) {
    const paths = tempEvent(pullEvent());
    const commands = [];
    let pulls = 0;
    try {
      const code = await run(baseEnv(paths, { GITHUB_REF: ref }), {
        writeCommand: (line) => commands.push(line),
        createClient: ({ token }) => {
          assert.equal(token, "job-token");
          return {
            getDefaultBranch: async () => "main",
            getPull: async () => { pulls += 1; return pull(); },
          };
        },
      });
      assert.equal(code, 1, ref);
      assert.equal(pulls, 0, ref);
      assert.deepEqual(commands, ["::error::ApexYard Gate: GITHUB_REF must be the default branch"]);
      assert.equal(existsSync(paths.outputPath), false);
      assert.equal(existsSync(paths.summaryPath), false);
    } finally {
      rmSync(paths.temp, { recursive: true, force: true });
    }
  }
});

test("refuses workflow_run on a non-default GITHUB_REF before resolving PRs", async () => {
  const paths = tempEvent({
    repository: { name: "top-level-decoy", owner: { login: "decoy" } },
    workflow_run: {
      head_sha: "f".repeat(40),
      repository: { name: "workflow-decoy", owner: { login: "decoy" } },
    },
  });
  const commands = [];
  let resolutions = 0;
  try {
    const code = await run(baseEnv(paths, {
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_REF: "refs/heads/feature",
    }), {
      writeCommand: (line) => commands.push(line),
      createClient: ({ token }) => {
        assert.equal(token, "job-token");
        return {
          getDefaultBranch: async () => "main",
          listPullsForCommit: async () => { resolutions += 1; return []; },
        };
      },
    });
    assert.equal(code, 1);
    assert.equal(resolutions, 0);
    assert.deepEqual(commands, ["::error::ApexYard Gate: GITHUB_REF must be the default branch"]);
  } finally {
    rmSync(paths.temp, { recursive: true, force: true });
  }
});

test("workflow_run trusts only the payload head SHA, prioritizes its current PR before the cap, and keeps tokens out of logs and files", async () => {
  const workflowSha = "f".repeat(40);
  const paths = tempEvent({
    repository: { name: "payload-decoy", owner: { login: "decoy" } },
    pull_request: { number: 999 },
    workflow_run: {
      head_sha: workflowSha,
      repository: { name: "workflow-decoy", owner: { login: "decoy" } },
      pull_requests: [{ number: 998 }],
    },
  });
  const commands = [];
  const loaded = [];
  const evaluated = [];
  const created = [];
  const updated = [];
  try {
    const readClient = {
      getDefaultBranch: async (owner, repo) => {
        assert.deepEqual([owner, repo], ["me2resh", "apexyard-demo"]);
        return "main";
      },
      listPullsForCommit: async (owner, repo, sha) => {
        assert.deepEqual([owner, repo, sha], ["me2resh", "apexyard-demo", workflowSha]);
        return [
          { number: 1, state: "closed" },
          { number: 2, state: "open" },
          { number: 3, state: "open" },
          { number: 4, state: "open" },
          { number: 5, state: "open" },
          { number: 6, state: "open" },
          { number: 7, state: "open" },
        ];
      },
      getPull: async (owner, repo, number) => {
        assert.deepEqual([owner, repo], ["me2resh", "apexyard-demo"]);
        loaded.push(number);
        const current = pull(number);
        return number === 7 ? { ...current, headSha: workflowSha } : current;
      },
    };
    const checkClient = {
      createCheck: async (owner, repo, body) => {
        created.push({ owner, repo, body });
        return { id: created.length };
      },
      updateCheck: async (owner, repo, id, body) => {
        updated.push({ owner, repo, id, body });
      },
    };
    const code = await run(baseEnv(paths, {
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_EVENT_PATH: paths.eventPath,
    }), {
      clock: () => NOW,
      writeCommand: (line) => commands.push(line),
      createClient: ({ token }) => {
        if (token === "job-token") return readClient;
        if (token === APP_TOKEN) return checkClient;
        return {
          getInstallation: async () => 808,
          createInstallationToken: async () => APP_TOKEN,
        };
      },
      evaluatePull: async (_client, _owner, _repo, current) => {
        evaluated.push(current.number);
        return { verdict: "pass", evidence: { facts: [] } };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(loaded, [2, 3, 4, 5, 6, 7]);
    assert.deepEqual(evaluated, [7, 2, 3, 4, 5]);
    assert.equal(created.length, 5);
    assert.equal(updated.length, 5);
    assert.deepEqual(created.map((entry) => entry.body.head_sha), [
      workflowSha,
      ...[2, 3, 4, 5].map((number) => pull(number).headSha),
    ]);
    const masks = commands.filter((line) => line.startsWith("::add-mask::"));
    assert.equal(masks.length, 2);
    assert.match(masks[0], /^::add-mask::[^.]+\.[^.]+\.[^.]+$/);
    assert.equal(masks[1], `::add-mask::${APP_TOKEN}`);
    assert.ok(commands.includes("::notice::ApexYard Gate: skipped pull request #1 because it is not open"));
    assert.ok(commands.includes("::notice::ApexYard Gate: dropped pull request #6 because the limit is 5"));
    assert.equal(commands.filter((line) => !line.startsWith("::add-mask::")).some((line) => line.includes(APP_TOKEN)), false);
    assert.equal(readFileSync(paths.outputPath, "utf8"), "verdict=pass\n");
    assert.equal(readFileSync(paths.outputPath, "utf8").includes(APP_TOKEN), false);
    assert.equal(readFileSync(paths.summaryPath, "utf8").includes(APP_TOKEN), false);
  } finally {
    rmSync(paths.temp, { recursive: true, force: true });
  }
});

test("workflow_run with zero open PRs exits without a token or check", async () => {
  const workflowSha = "e".repeat(40);
  const paths = tempEvent({
    repository: { name: "apexyard-demo", owner: { login: "me2resh" } },
    workflow_run: { head_sha: workflowSha },
  });
  const commands = [];
  let nonReadClients = 0;
  try {
    const code = await run(baseEnv(paths, { GITHUB_EVENT_NAME: "workflow_run" }), {
      writeCommand: (line) => commands.push(line),
      createClient: ({ token }) => {
        if (token !== "job-token") {
          nonReadClients += 1;
          throw new Error("must not mint or post");
        }
        return {
          getDefaultBranch: async () => "main",
          listPullsForCommit: async (_owner, _repo, sha) => {
            assert.equal(sha, workflowSha);
            return [{ number: 9, state: "closed" }];
          },
        };
      },
    });
    assert.equal(code, 0);
    assert.equal(nonReadClients, 0);
    assert.deepEqual(commands, [
      "::notice::ApexYard Gate: skipped pull request #9 because it is not open",
    ]);
    assert.equal(existsSync(paths.outputPath), false);
    assert.equal(existsSync(paths.summaryPath), false);
  } finally {
    rmSync(paths.temp, { recursive: true, force: true });
  }
});

test("workflow_run skips a PR that closes before it is reloaded", async () => {
  const workflowSha = "c".repeat(40);
  const paths = tempEvent({
    repository: { name: "apexyard-demo", owner: { login: "me2resh" } },
    workflow_run: { head_sha: workflowSha },
  });
  const commands = [];
  let nonReadClients = 0;
  try {
    const code = await run(baseEnv(paths, { GITHUB_EVENT_NAME: "workflow_run" }), {
      writeCommand: (line) => commands.push(line),
      createClient: ({ token }) => {
        if (token !== "job-token") {
          nonReadClients += 1;
          throw new Error("must not mint or post");
        }
        return {
          getDefaultBranch: async () => "main",
          listPullsForCommit: async () => [{ number: 10, state: "open" }],
          getPull: async () => pull(10, "closed"),
        };
      },
    });
    assert.equal(code, 0);
    assert.equal(nonReadClients, 0);
    assert.deepEqual(commands, [
      "::notice::ApexYard Gate: skipped pull request #10 because it is no longer open",
    ]);
  } finally {
    rmSync(paths.temp, { recursive: true, force: true });
  }
});

test("workflow_run validates GITHUB_REPOSITORY before creating a client", async () => {
  const paths = tempEvent({
    repository: { name: "apexyard-demo", owner: { login: "me2resh" } },
    workflow_run: {
      head_sha: "b".repeat(40),
      repository: { name: "apexyard-demo", owner: { login: "me2resh" } },
    },
  });
  const commands = [];
  let clients = 0;
  try {
    const code = await run(baseEnv(paths, {
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_REPOSITORY: "me2resh/apexyard-demo/extra",
    }), {
      writeCommand: (line) => commands.push(line),
      createClient: () => { clients += 1; throw new Error("must not create a client"); },
    });
    assert.equal(code, 1);
    assert.equal(clients, 0);
    assert.deepEqual(commands, ["::error::ApexYard Gate: gate execution failed"]);
  } finally {
    rmSync(paths.temp, { recursive: true, force: true });
  }
});
