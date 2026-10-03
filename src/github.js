const SHA = /^[0-9a-f]{40}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function assertRef(value, message) {
  if (typeof value !== "string" || !REF.test(value) || value.includes("..")) {
    throw new Error(message);
  }
}

export function assertGitHubApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("host not allowed");
  }
  if (url.protocol !== "https:") throw new Error("host not allowed");
  if (url.hostname !== "api.github.com") throw new Error("host not allowed");
  if (url.username !== "" || url.password !== "") throw new Error("host not allowed");
  if (url.port !== "" && url.port !== "443") throw new Error("host not allowed");
  return url;
}

function repoPath(owner, repo) {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function assertSha(value, message) {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error(message);
}

function nextLink(headers) {
  const link = headers.get("link");
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

export function createClient({ token, fetchImpl = globalThis.fetch }) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("missing token");
  }

  async function call(url, { method = "GET", body } = {}) {
    assertGitHubApiUrl(url);
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "apexyard-gate",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const init = { method, redirect: "error", headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(url, init);
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  }

  async function callJson(url, options) {
    const response = await call(url, options);
    if (response.status === 404) return { missing: true, body: null, headers: response.headers };
    if (response.status < 200 || response.status >= 300) throw new Error(`github ${response.status}`);
    const body = response.text === "" ? null : JSON.parse(response.text);
    return { missing: false, body, headers: response.headers };
  }

  async function paginate(url, maxPages = 20, truncate = false, listError = "expected list") {
    const items = [];
    const seen = new Set();
    let pageUrl = url;
    let pages = 0;
    while (pageUrl && pages < maxPages) {
      if (seen.has(pageUrl)) throw new Error("page cycle");
      seen.add(pageUrl);
      pages += 1;
      const result = await callJson(pageUrl);
      if (result.missing || !Array.isArray(result.body)) throw new Error(listError);
      items.push(...result.body);
      pageUrl = nextLink(result.headers);
    }
    if (pageUrl && !truncate) throw new Error("too many pages");
    return items;
  }

  return {
    async getPull(owner, repo, number) {
      const result = await callJson(`${repoPath(owner, repo)}/pulls/${number}`);
      if (result.missing || !result.body) throw new Error("missing pull request");
      const sha = result.body.head && result.body.head.sha;
      const baseRef = result.body.base && result.body.base.ref;
      const user = result.body.user;
      if (typeof sha !== "string" || !SHA.test(sha)) throw new Error("bad head sha");
      assertRef(baseRef, "bad base ref");
      if (!user || !Number.isSafeInteger(user.id) || typeof user.login !== "string" || typeof user.type !== "string") {
        throw new Error("bad author");
      }
      const state = typeof result.body.state === "string" ? result.body.state : "";
      return {
        number,
        headSha: sha,
        baseRef,
        state,
        author: { id: user.id, login: user.login, type: user.type },
      };
    },

    async getDefaultBranch(owner, repo) {
      const result = await callJson(repoPath(owner, repo));
      if (result.missing || !result.body || typeof result.body !== "object") {
        throw new Error("missing repository");
      }
      const branch = result.body.default_branch;
      assertRef(branch, "bad default branch");
      return branch;
    },

    async getInstallation(owner, repo) {
      const result = await callJson(`${repoPath(owner, repo)}/installation`);
      const id = result.body && result.body.id;
      if (result.missing || !Number.isSafeInteger(id) || id < 1) {
        throw new Error("missing installation");
      }
      return id;
    },

    async createInstallationToken(installationId, repo) {
      if (!Number.isSafeInteger(installationId) || installationId < 1) {
        throw new Error("bad installation");
      }
      if (typeof repo !== "string" || repo.length === 0) throw new Error("bad repository");
      const result = await callJson(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          body: {
            repositories: [repo],
            permissions: { checks: "write" },
          },
        },
      );
      const accessToken = result.body && result.body.token;
      if (result.missing || typeof accessToken !== "string" || accessToken.length === 0) {
        throw new Error("token request failed");
      }
      return accessToken;
    },

    async listPullsForCommit(owner, repo, sha) {
      assertSha(sha, "bad workflow head sha");
      const items = await paginate(
        `${repoPath(owner, repo)}/commits/${sha}/pulls?per_page=100`,
        3,
        true,
        "expected pull list",
      );
      const pulls = [];
      for (const pull of items) {
        if (!pull || !Number.isSafeInteger(pull.number) || pull.number < 1) continue;
        if (typeof pull.state !== "string") continue;
        pulls.push({ number: pull.number, state: pull.state });
      }
      return pulls;
    },

    async getBranchSha(owner, repo, branch) {
      const ref = branch.split("/").map(encodeURIComponent).join("/");
      const result = await callJson(`${repoPath(owner, repo)}/git/ref/heads/${ref}`);
      if (result.missing || !result.body || !result.body.object) throw new Error("missing base ref");
      const sha = result.body.object.sha;
      if (typeof sha !== "string" || !SHA.test(sha)) throw new Error("bad base sha");
      return sha;
    },

    async getFile(owner, repo, path, ref) {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const url = `${repoPath(owner, repo)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
      const result = await callJson(url);
      if (result.missing) return { missing: true };
      const body = result.body;
      if (!body || body.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string") {
        return { missing: true };
      }
      const bytes = Buffer.from(body.content.replace(/\s+/g, ""), "base64");
      const size = Number.isSafeInteger(body.size) ? body.size : bytes.length;
      return { missing: false, bytes, size };
    },

    listReviews(owner, repo, number) {
      return paginate(`${repoPath(owner, repo)}/pulls/${number}/reviews?per_page=100`);
    },

    listCommits(owner, repo, number) {
      return paginate(`${repoPath(owner, repo)}/pulls/${number}/commits?per_page=100`);
    },

    listFiles(owner, repo, number) {
      return paginate(`${repoPath(owner, repo)}/pulls/${number}/files?per_page=100`);
    },

    async closingIssues(owner, repo, number) {
      const query = `query($owner:String!,$name:String!,$number:Int!){
        repository(owner:$owner,name:$name){
          pullRequest(number:$number){
            closingIssuesReferences(first:100){
              nodes{ number state repository{ name owner{ login } } }
            }
          }
        }
      }`;
      const result = await callJson("https://api.github.com/graphql", {
        method: "POST",
        body: { query, variables: { owner, name: repo, number } },
      });
      if (result.missing || !result.body) throw new Error("graphql failed");
      if (result.body.errors) throw new Error("graphql failed");
      const pull = result.body.data && result.body.data.repository && result.body.data.repository.pullRequest;
      if (!pull || !pull.closingIssuesReferences || !Array.isArray(pull.closingIssuesReferences.nodes)) {
        throw new Error("graphql failed");
      }
      const issues = [];
      for (const node of pull.closingIssuesReferences.nodes) {
        if (!node || !node.repository || !node.repository.owner) continue;
        if (!Number.isSafeInteger(node.number)) continue;
        issues.push({
          number: node.number,
          state: node.state,
          repository: { owner: node.repository.owner.login, name: node.repository.name },
        });
      }
      return issues;
    },

    async createCheck(owner, repo, payload) {
      const result = await callJson(`${repoPath(owner, repo)}/check-runs`, {
        method: "POST",
        body: payload,
      });
      if (result.missing || !result.body || !Number.isSafeInteger(result.body.id)) {
        throw new Error("check create failed");
      }
      return { id: result.body.id };
    },

    async updateCheck(owner, repo, id, payload) {
      const result = await callJson(`${repoPath(owner, repo)}/check-runs/${id}`, {
        method: "PATCH",
        body: payload,
      });
      if (result.missing) throw new Error("check update failed");
      return result.body;
    },
  };
}
