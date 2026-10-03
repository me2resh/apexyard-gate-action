import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertGitHubApiUrl, createClient } from "../src/github.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/network/network-allow-list.json", import.meta.url), "utf8"));

test("the client accepts only api.github.com", async () => {
  for (const url of fixture.allowed) {
    assert.equal(assertGitHubApiUrl(url).hostname, "api.github.com");
  }
  for (const url of fixture.rejected) {
    assert.throws(() => assertGitHubApiUrl(url), /host not allowed/);
  }
  const calls = [];
  const client = createClient({
    token: "test-token",
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      assert.equal(new URL(url).hostname, "api.github.com");
      assert.equal(init.redirect, "error");
      return {
        status: 200,
        headers: new Headers({ link: `<${fixture.nextHost}>; rel="next"` }),
        text: async () => "[]",
      };
    },
  });
  await assert.rejects(() => client.listReviews("me2resh", "apexyard-demo", 1), /host not allowed/);
  assert.deepEqual(calls, [
    "https://api.github.com/repos/me2resh/apexyard-demo/pulls/1/reviews?per_page=100",
  ]);
});

test("a missing token is rejected", () => {
  assert.throws(() => createClient({ token: "" }), /missing token/);
});

test("a bad default_branch value is refused", async () => {
  const samples = [
    [{ default_branch: ".." }, false],
    [{ default_branch: "release/../main" }, false],
    [{ default_branch: "" }, false],
    [{ default_branch: "-main" }, false],
    [{ default_branch: "bad ref" }, false],
    [{ default_branch: "m".repeat(129) }, false],
    [{ default_branch: null }, false],
    [{ default_branch: 1 }, false],
    [{ default_branch: "main\n" }, false],
    [{ default_branch: ".hidden" }, false],
    [{}, false],
    [{ default_branch: "main" }, true],
    [{ default_branch: "feature/GH-1" }, true],
    [{ default_branch: "m".repeat(128), base: "event-base" }, true],
  ];
  for (const [body, ok] of samples) {
    const urls = [];
    const client = createClient({
      token: "test-token",
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        assert.equal(init.method, "GET");
        assert.equal(new URL(url).pathname, "/repos/me2resh/apexyard-demo");
        assert.equal(new URL(url).search, "");
        return {
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify(body),
        };
      },
    });
    if (ok) {
      assert.equal(await client.getDefaultBranch("me2resh", "apexyard-demo"), body.default_branch);
    } else {
      await assert.rejects(
        () => client.getDefaultBranch("me2resh", "apexyard-demo"),
        /bad default branch/,
      );
    }
    assert.deepEqual(urls, ["https://api.github.com/repos/me2resh/apexyard-demo"]);
  }
});

test("commit pull resolution validates the SHA and keeps only number and state", async () => {
  const sha = "a".repeat(40);
  const client = createClient({
    token: "read-token",
    fetchImpl: async (url, init) => {
      assert.equal(String(url), `https://api.github.com/repos/me2resh/apexyard-demo/commits/${sha}/pulls?per_page=100`);
      assert.equal(init.method, "GET");
      return {
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify([
          { number: 7, state: "open", head: { sha: "payload-is-not-trusted" } },
          null,
          { number: 0, state: "open" },
          { number: 8 },
          { number: 9, state: "closed" },
        ]),
      };
    },
  });
  assert.deepEqual(await client.listPullsForCommit("me2resh", "apexyard-demo", sha), [
    { number: 7, state: "open" },
    { number: 9, state: "closed" },
  ]);
  await assert.rejects(() => client.listPullsForCommit("me2resh", "apexyard-demo", "bad"), /bad workflow head sha/);
});

test("installation endpoints reject missing or unscoped responses", async () => {
  const bodies = [
    [{ id: 0 }, "missing installation"],
    [{}, "missing installation"],
  ];
  for (const [body, message] of bodies) {
    const client = createClient({
      token: "jwt",
      fetchImpl: async () => ({
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify(body),
      }),
    });
    await assert.rejects(() => client.getInstallation("o", "r"), new RegExp(message));
  }

  const noFetch = createClient({ token: "jwt", fetchImpl: async () => { throw new Error("unexpected fetch"); } });
  await assert.rejects(() => noFetch.createInstallationToken(0, "r"), /bad installation/);
  await assert.rejects(() => noFetch.createInstallationToken(1, ""), /bad repository/);

  const badToken = createClient({
    token: "jwt",
    fetchImpl: async () => ({
      status: 201,
      headers: new Headers(),
      text: async () => JSON.stringify({ token: "" }),
    }),
  });
  await assert.rejects(() => badToken.createInstallationToken(1, "r"), /token request failed/);
});

test("commit pull resolution rejects a non-list response", async () => {
  const client = createClient({
    token: "read-token",
    fetchImpl: async () => ({
      status: 200,
      headers: new Headers(),
      text: async () => "{}",
    }),
  });
  await assert.rejects(
    () => client.listPullsForCommit("o", "r", "b".repeat(40)),
    /expected pull list/,
  );
});

test("commit pull resolution follows up to three pages and finds an open PR behind closed ones", async () => {
  const sha = "c".repeat(40);
  const calls = [];
  const client = createClient({
    token: "read-token",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.href);
      const page = Number(parsed.searchParams.get("page") ?? "1");
      assert.equal(parsed.searchParams.get("per_page"), "100");
      const next = new URL(parsed);
      next.searchParams.set("page", String(page + 1));
      if (page === 1) {
        return {
          status: 200,
          headers: new Headers({ link: `<${next.href}>; rel="next"` }),
          text: async () => JSON.stringify([{ number: 1, state: "closed" }]),
        };
      }
      if (page === 2) {
        return {
          status: 200,
          headers: new Headers({ link: `<${next.href}>; rel="next"` }),
          text: async () => JSON.stringify([{ number: 2, state: "open" }]),
        };
      }
      return {
        status: 200,
        headers: new Headers({ link: `<${next.href}>; rel="next"` }),
        text: async () => JSON.stringify([{ number: 3, state: "closed" }]),
      };
    },
  });

  assert.deepEqual(await client.listPullsForCommit("me2resh", "apexyard-demo", sha), [
    { number: 1, state: "closed" },
    { number: 2, state: "open" },
    { number: 3, state: "closed" },
  ]);
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[0]).search, "?per_page=100");
  assert.equal(new URL(calls[1]).searchParams.get("page"), "2");
  assert.equal(new URL(calls[2]).searchParams.get("page"), "3");
});
