import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { AppTokenError, createAppJwt, createAppToken } from "../src/app-token.js";

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_KEY = privateKey.export({ type: "pkcs8", format: "pem" });

function decode(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

test("creates an RS256 JWT with the required claims and injected clock", () => {
  const jwt = createAppJwt({ appId: "12345\n", appKey: APP_KEY, clock: () => NOW });
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  assert.deepEqual(decode(parts[0]), { alg: "RS256", typ: "JWT" });
  const claims = decode(parts[1]);
  const now = Math.floor(NOW / 1000);
  assert.deepEqual(claims, { iat: now - 60, exp: now + 540, iss: "12345" });
  assert.ok(claims.exp - claims.iat <= 600);
  assert.equal(
    verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url")),
    true,
  );
});

test("looks up the installation and requests a repository-scoped checks token", async () => {
  const calls = [];
  const masks = [];
  const token = await createAppToken({
    appId: 12345,
    appKey: APP_KEY,
    owner: "me2resh",
    repo: "apexyard-demo",
  }, {
    clock: () => new Date(NOW),
    createClient: ({ token: jwt, fetchImpl }) => {
      assert.equal(fetchImpl, undefined);
      assert.equal(decode(jwt.split(".")[1]).iss, "12345");
      assert.deepEqual(masks, [jwt]);
      return {
        async getInstallation(owner, repo) {
          calls.push(["installation", owner, repo]);
          return 808;
        },
        async createInstallationToken(id, repo) {
          calls.push(["token", id, repo]);
          return "ghs_scoped-token";
        },
      };
    },
    maskToken: (value) => masks.push(value),
  });
  assert.equal(token, "ghs_scoped-token");
  assert.deepEqual(calls, [
    ["installation", "me2resh", "apexyard-demo"],
    ["token", 808, "apexyard-demo"],
  ]);
  assert.equal(masks.length, 2);
  assert.match(masks[0], /^[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(masks[1], "ghs_scoped-token");
});

test("the HTTP client sends the JWT lookup and the scoped token body", async () => {
  const calls = [];
  const masks = [];
  const minted = await createAppToken({
    appId: "12345",
    appKey: APP_KEY,
    owner: "me2resh",
    repo: "apexyard-demo",
  }, {
    clock: () => NOW,
    fetchImpl: async (url, init) => {
      assert.equal(masks.length, 1);
      assert.equal(masks[0], init.headers.Authorization.slice("Bearer ".length));
      calls.push({ url: String(url), init });
      assert.equal(new URL(url).hostname, "api.github.com");
      assert.match(init.headers.Authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      if (String(url).endsWith("/installation")) {
        return { status: 200, headers: new Headers(), text: async () => JSON.stringify({ id: 808 }) };
      }
      return {
        status: 201,
        headers: new Headers(),
        text: async () => JSON.stringify({ token: "ghs_scoped-token" }),
      };
    },
    maskToken: (value) => masks.push(value),
  });
  assert.equal(minted, "ghs_scoped-token");
  assert.equal(masks.length, 2);
  assert.equal(masks[1], minted);
  assert.equal(calls[0].url, "https://api.github.com/repos/me2resh/apexyard-demo/installation");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].url, "https://api.github.com/app/installations/808/access_tokens");
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    repositories: ["apexyard-demo"],
    permissions: { checks: "write" },
  });
});

test("names each App token failure step without exposing the cause", async () => {
  await assert.rejects(
    () => createAppToken({ appId: "12345", appKey: "bad", owner: "o", repo: "r" }, {
      clock: () => NOW,
      maskToken: () => {},
    }),
    (error) => error instanceof AppTokenError && error.message === "JWT creation failed",
  );
  await assert.rejects(
    () => createAppToken({ appId: "12345", appKey: APP_KEY, owner: "o", repo: "r" }, {
      clock: () => NOW,
      createClient: () => ({ getInstallation: async () => { throw new Error("secret cause"); } }),
      maskToken: () => {},
    }),
    (error) => error instanceof AppTokenError
      && error.message === "installation lookup failed"
      && !error.message.includes("secret cause"),
  );
  await assert.rejects(
    () => createAppToken({ appId: "12345", appKey: APP_KEY, owner: "o", repo: "r" }, {
      clock: () => NOW,
      createClient: () => ({
        getInstallation: async () => 1,
        createInstallationToken: async () => { throw new Error("ghs_secret-cause"); },
      }),
      maskToken: () => {},
    }),
    (error) => error instanceof AppTokenError
      && error.message === "token request failed"
      && !error.message.includes("ghs_secret-cause"),
  );
});

test("rejects invalid JWT inputs and a failed mask", async () => {
  for (const appId of ["", "abc", null]) {
    assert.throws(() => createAppJwt({ appId, appKey: APP_KEY, clock: () => NOW }), /bad app id/);
  }
  assert.throws(() => createAppJwt({ appId: "1", appKey: "", clock: () => NOW }), /bad app key/);
  assert.throws(() => createAppJwt({ appId: "1", appKey: APP_KEY, clock: () => Number.NaN }), /bad clock/);
  await assert.rejects(
    () => createAppToken({ appId: "1", appKey: APP_KEY, owner: "o", repo: "r" }, {
      clock: () => NOW,
      createClient: () => ({ getInstallation: async () => 0 }),
      maskToken: () => {},
    }),
    /installation lookup failed/,
  );
  await assert.rejects(
    () => createAppToken({ appId: "1", appKey: APP_KEY, owner: "o", repo: "r" }, {
      clock: () => NOW,
      createClient: () => ({
        getInstallation: async () => 1,
        createInstallationToken: async () => "",
      }),
      maskToken: () => {},
    }),
    /token request failed/,
  );
  await assert.rejects(
    () => createAppToken({ appId: "1", appKey: APP_KEY, owner: "o", repo: "r" }, {
      clock: () => NOW,
      createClient: () => ({
        getInstallation: async () => 1,
        createInstallationToken: async () => "ghs_token",
      }),
      maskToken: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          if (calls === 2) throw new Error("mask failed");
        };
      })(),
    }),
    /token masking failed/,
  );
});

test("rejects installation tokens with whitespace before masking them", async () => {
  for (const token of ["ghs bad", "ghs_bad\n", "ghs_bad\t"]) {
    const masks = [];
    await assert.rejects(
      () => createAppToken({ appId: "1", appKey: APP_KEY, owner: "o", repo: "r" }, {
        clock: () => NOW,
        createClient: () => ({
          getInstallation: async () => 1,
          createInstallationToken: async () => token,
        }),
        maskToken: (value) => masks.push(value),
      }),
      (error) => error instanceof AppTokenError && error.message === "token request failed",
    );
    assert.equal(masks.length, 1);
    assert.match(masks[0], /^[^.]+\.[^.]+\.[^.]+$/);
    assert.equal(masks.includes(token), false);
  }
});

test("does not make a request when JWT masking fails", async () => {
  let clients = 0;
  await assert.rejects(
    () => createAppToken({ appId: "1", appKey: APP_KEY, owner: "o", repo: "r" }, {
      clock: () => NOW,
      createClient: () => { clients += 1; },
      maskToken: () => { throw new Error("mask failed"); },
    }),
    (error) => error instanceof AppTokenError && error.message === "JWT masking failed",
  );
  assert.equal(clients, 0);
});
