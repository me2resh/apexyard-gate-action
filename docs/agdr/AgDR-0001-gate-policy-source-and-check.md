---
id: AgDR-0001
timestamp: 2026-10-01T19:00:00Z
agent: hisham (tech-lead)
model: claude-opus-5-5
trigger: user-prompt
status: accepted
category: security
projects: [apexyard-gate]
---


# AgDR-0001: Gate policy source, evaluator and the skeleton checks

> In the context of the ApexYard walking skeleton, facing a required check that a pull request could weaken by editing its own policy or workflow, I decided that the gate reads its policy only from the base branch through the GitHub API, verifies the signed pack, evaluates with a pure function, and runs on `pull_request_target` and `pull_request_review`, and that the repository's rulesets stop workflow changes from anyone but a policy owner, to achieve a check that proves the agreed process ran on the head SHA, accepting that the gate's safety depends on correct ruleset setup.

- **Status**: Accepted
- **Date**: 2026-10-01
- **Ticket**: the ApexYard walking skeleton (tracked in the product's private tracker). Product plan criteria ac2-1, ac2-2 in part, ac3-5, ac3a-1 and a subset of ac6-1.
- **Related**: the runner's run-record decision (run record, trailer) and the cloud signing service's decision (pack signing, pull script). Both are private.
- **Owner decisions (2026-10-01)**: Accept the Contrarian's points. The demo repository is a new public repository, `me2resh/apexyard-demo`, in the owner's personal account. This repository becomes public (MIT) when gate v0 is ready.

## Context

- The product plan says: the Action reads its policy only from the base branch and posts one check run on the PR head SHA (ac2-1). The check fails with no linked ticket, or with no approval on the head SHA from an allowlisted human who is not the author (ac2-2). No merge calls the cloud (ac3-5). The gate refuses an unsigned or tampered pack (ac3a-1).
- The slice does not include ac2-3 (fail closed on workflow or policy edits), the AgDR-paths rule, or the last-pusher condition (Tariq).
- The product security model: protect `.apexyard/`, `.github/workflows` and CODEOWNERS with rulesets. The evaluator runs code from the base branch. The gate core is MIT.
- `me2resh/apexyard-gate` exists. It is private now and becomes public (MIT) at gate v0. Its base branch holds a README and a LICENSE only.
- The runner's run-record decision puts the run record at `docs/runs/<run-id>.json`, with a 4 KB cap, and the `ApexYard-Run:` trailer on the helper's commit. Every record fact is reported.
- The cloud signing service puts the signed pack at `.apexyard/pack.json` and `.apexyard/pack.json.sig` on the base branch, through a PR that a policy owner opens. The pack's one rule is `AY-TICKET-001`, "linked ticket".
- The agent runs on the developer's Mac under the developer's GitHub account. The developer is the PR author. A teammate approves.
- GitHub Actions posts every `GITHUB_TOKEN` check run under one app identity. Any workflow on any branch can post a check run with any name on any commit (Hakim, blocking 1). A workflow that runs PR code, such as a test script, can do the same with its job token (Hakim, G-1).

## Decisions and options

### 1. The policy source: the base branch only

| Option | Result |
|---|---|
| **Read each policy file from the base branch head through the GitHub API** | Chosen. The PR under review cannot change the policy that judges it. |
| Check out the merge ref and read the files there | Rejected. The merge ref holds the PR's own edits. |
| Fetch the policy from the cloud at check time | Rejected. It puts the cloud in the merge path (ac3-5). |
| Pass the policy as action inputs in the workflow file | Rejected. A review-triggered run reads the workflow file from the PR (decision 5). |

The policy files:

| File | Owner | Trust |
|---|---|---|
| `.apexyard/pack.json` and `.apexyard/pack.json.sig` | ApexScript | Signature verified with a public key pinned in the gate source, by `kid`. |
| `.apexyard/gate.json` | The repository | Trusted because it is on the base branch, and Code Owner review protects it (decision 6). |

`.apexyard/gate.json` for the skeleton holds approvers only:

```json
{
  "v": 1,
  "approvers": [12345678, 23456789]
}
```

The list holds numeric GitHub user IDs, because a login can change.

The resolution steps:

1. At start, the gate resolves the base branch head to a SHA with `GET /repos/{owner}/{repo}/git/ref/heads/<base>`.
2. The gate reads each file at that SHA as raw bytes.
3. The gate records that SHA in the evidence.
4. A missing file, invalid JSON, a bad signature, an unknown `kid` or a schema failure gives verdict `fail` with a reason.

### 2. The evaluator: a pure function

| Option | Result |
|---|---|
| **A pure function, `(policy, PR state) -> (verdict, reasons)`, with a separate I/O shell** | Chosen. Fixtures test every rule with no network. |
| One script that calls the API while it decides | Rejected. It needs API mocks to test. |

```ts
evaluate(policy: Policy, pr: PrState): {
  verdict: "pass" | "fail";
  reasons: Reason[];   // one per rule: rule ID, outcome, detail
  evidence: Evidence;  // facts for the summary, each labelled verified or reported
}
```

- The shell reads the API and builds `Policy` and `PrState`. The evaluator does no I/O and reads no clock or environment.
- `verifyPack(bytes, sig, pinnedKeys)` is a second pure function. `Policy` carries its result.
- `PrState` holds: the repository, the PR number, the author, the head SHA, the base ref and SHA, the reviews, the linked issues, the commit trailers, up to 5 parsed run records and the AgDR files.
- No verdict reads a run-record field. Run records feed the evidence only (Hakim).
- Each case has one JSON fixture.

The gate repository holds a pinned copy of `job.v1.json` and `run-record.v1.json` from the runner, with the source commit SHA, because the runner repository is private (Tariq).

### 3. The skeleton checks

**Check A: linked ticket.** This is the pack rule `AY-TICKET-001` (`enforcement: blocking`, `check: linked-ticket`). The Runner shows the same rule from the cloud.

- It passes when the PR's GraphQL `closingIssuesReferences` holds at least one open issue in the same repository.
- GitHub parses closing keywords only for PRs into the default branch. The demo uses the default branch.
- Check A applies to every PR, including the pack PR (a decision of the cloud signing service). The policy owner links an open issue in the pack PR body (Tariq).
- The agent writes the PR body, so it can link any open issue. The fact "a link exists" is verified, but the evidence shows the issue number so the approver can check it (Hakim).
- A blocking rule with an unknown `check` value fails. An advisory rule with an unknown value shows as "not evaluated".

**Check B: approval on the head SHA.** This is in the gate core and always runs. An approval counts only when all of these are true:

1. It is the reviewer's latest review, ignoring `COMMENTED` reviews. Its state is `APPROVED`.
2. Its `commit_id` equals the head SHA.
3. The reviewer's ID is in `approvers`.
4. The reviewer's account type is `User`, not `Bot`.
5. The reviewer is not the PR author.

The shell reads every page of reviews before it picks each reviewer's latest review. Otherwise an old approval can look like the latest one (Hakim).

The gate passes only when checks A and B both pass.

**Deferred (Tariq).**

- The last-pusher condition. The ruleset rule "require approval of the most recent reviewable push" covers it (decision 6). A gate lookup through the activity API could fail closed and break the demo.
- Check C, protected paths (ac2-3). Code Owner review and the push ruleset protect those paths (decision 6).

### 4. The evidence record: the only list of facts

The gate posts one check run named `ApexYard Gate` on the head SHA. `output.title` states the verdict. `output.summary` is a table: fact, value, label. This is the only list of facts and labels. The runner's run-record decision refers to it.

| Fact | Label |
|---|---|
| Head SHA | verified |
| Base SHA the policy was read from | verified |
| Pack version, team and signature result | verified by signature |
| Linked ticket: the issue number | verified |
| Approver: login, ID, review ID, reviewed commit | verified |
| PR author | verified |
| Last pusher | not checked by the gate. The ruleset checks it. |
| Run IDs from `ApexYard-Run:` trailers, and "n of m commits carry the trailer" | reported |
| ORBIT slice, from the run record | reported |
| Harness, mode and model, from the run record | reported |
| AgDR paths | presence verified, run link reported |

The run records:

- The gate reads at most 5 run records for each PR, from `docs/runs/<run-id>.json` at the head SHA, through the contents API (Tariq). It takes the first 5 distinct run IDs in commit order.
- It treats each file as data and never runs it.
- It refuses a file over 4 KB, the cap in `run-record.v1.json`. It validates each file against that schema. An invalid record shows as "not reported".

The AgDR run link:

- The gate reads at most 20 `docs/agdr/AgDR-*.md` files that the PR adds or changes, each up to 64 KB. It shows a count for the rest.
- It finds the run ID with one anchored regex inside the frontmatter: `^run: (ayr-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8})$`. It uses no YAML library (Tariq).

Rendering rules:

- The summary shows only values that passed a pattern check: SHAs, IDs, logins, slice IDs and paths.
- The gate escapes `|` in every table cell (Hakim).
- Paths appear in code spans. A path that holds a backtick or a line break is refused.
- The summary never holds the PR title, the PR body or issue text.
- The summary stays under 60,000 characters, below GitHub's limit of 65,535.
- The summary does not show "run record unchanged after its creation commit". The agent can rewrite and force-push its branch, so the fact proves little (Hakim, Tariq).

**Fail closed on a crash (Hakim).** The gate first posts the check run as `in_progress`. Any exception sets the conclusion to `failure` with the reason "gate error". A crashed rerun cannot leave an old `success` in place.

### 5. `pull_request_target` against `pull_request`

| Option | Result |
|---|---|
| `pull_request` only | Rejected. The workflow file and the action version come from the PR's merge ref. The PR under review can change the code that judges it. |
| **`pull_request_target` for PR events, plus `pull_request_review` for review events** | Chosen. The workflow and the action version for PR events come from the default branch. An approval runs the check again on the head SHA (Contrarian, accepted). |
| `pull_request_target`, plus a `workflow_run` relay for reviews | Deferred. It covers fork PRs, but adds a second workflow. The skeleton has no fork PRs. |
| A GitHub App with its own identity | Deferred. Add it before stage 2a or the first external repository (Hakim). |

The trigger details:

- `pull_request_target`, types `opened`, `reopened`, `synchronize`, `edited`, `ready_for_review`. GitHub runs this workflow from the default branch. GitHub's change of 8 Dec 2025 made this apply even when the base is another branch. A build test sends a PR to a non-default base and checks which workflow file ran.
- `pull_request_review`, types `submitted`, `edited`, `dismissed`. This run uses the workflow file from the PR's merge ref, because GitHub has no review event that runs from the base. Decision 6 closes this path.

The rules for both jobs:

- `permissions` are `checks: write`, `contents: read`, `pull-requests: read`, `issues: read`. Nothing else.
- The jobs use no secrets.
- The jobs never run `actions/checkout` and never run PR code.
- No `run:` step and no `actions/github-script` `script:` input expands `${{ github.event.* }}` or `${{ github.head_ref }}` (Hakim).
- The workflow pins the action by its full commit SHA.
- A `concurrency` group per PR number cancels a run in progress when a newer one starts.
- At start, the action reads the PR again and uses its current head SHA, not the SHA in the event payload.
- The action posts the result with the Checks API. A `pull_request_target` job status attaches to a default-branch commit, not to the PR head.
- The workflow job is named `apexyard-gate-evaluate`, never `ApexYard Gate`. On `pull_request_review`, the job's own check run can attach to the head SHA. A job with the same name could then satisfy the required check (Tariq).
- The job also ends red when the verdict is `fail`, so its own status never shows green after a failed verdict.

A test in apexyard-gate enforces these rules on the shipped workflow template.

### 6. Rulesets: the backstop against a spoofed check (Hakim, blocking 1)

A workflow on any branch, or in any PR, can post a check run named `ApexYard Gate: success` on this PR's head SHA. Code Owner review of this PR never sees that file. A workflow that runs PR code can do the same: the agent changes a test script, and the script posts the check with the job's token (Hakim, G-1). The gate cannot prevent either path. The demo repository therefore needs these controls:

**Workflow token permissions (Hakim, G-1).**

1. Set the repository's default workflow permissions to read-only.
2. Only the gate workflow holds `checks: write`.
3. No other workflow holds `checks: write` or `statuses: write`. This matters most for a workflow that runs code from the PR.
4. Code Owner review of `.github/workflows/**` keeps this rule in place.

This rule ends when the GitHub App identity arrives (decision 5, deferred). The required check then names the App, not GitHub Actions. That rule now ends: [AgDR-0002](AgDR-0002-gate-check-identity.md) removes `checks: write` from the job because the adopter-owned App posts the check.

**Push ruleset, all branches.**

1. Block pushes that add or change `.github/workflows/**` or `.github/actions/**`.
2. Allow only the policy owners to bypass it.

GitHub likely offers push rulesets only on private and internal repositories. So plan the fallback as the default path for the public demo repository (Tariq). The build checks whether a push ruleset is available. The fallback:

- The developer account's push credential has no `workflow` scope. Check with `gh auth status`. Remove it with `gh auth refresh --remove-scopes workflow`.
- The developer account has no SSH key. An SSH push ignores OAuth scopes.

**Branch ruleset on `main`.**

1. Require the status check `ApexYard Gate`, pinned to the GitHub Actions app as its source. A user token can then not satisfy it with a commit status of the same name.
2. Require one approval. Dismiss stale approvals on push. Require approval of the most recent reviewable push.
3. Require review from Code Owners. CODEOWNERS names the policy owners for `.github/workflows/**`, `.github/actions/**`, `.apexyard/**`, `CODEOWNERS` and `.github/CODEOWNERS`.
4. Block force pushes and branch deletion.
5. Use merge commits, so trailers stay in the final trailer block (the runner's run-record decision).

**Accounts.**

- The account that runs the agent is a collaborator with write access. It is not an admin and not on any bypass list.
- In a personal-account repository, the owner account is always an admin. So the agent must not run under the owner account.
- CODEOWNERS names at least two policy owners. GitHub does not count an author's own review, so a pack PR that one policy owner opens needs the other.
- Every account in `approvers` and every policy owner is a collaborator with write access.

**Setup order (Tariq).** The gate fails when the base branch has no pack or no `gate.json`. So set up the demo repository in this order:

1. Commit `.apexyard/gate.json`, `.apexyard/pack.json`, `.apexyard/pack.json.sig` and CODEOWNERS to `main`.
2. Set the default workflow permissions to read-only.
3. Turn on the rulesets and the required check.
4. Run the live tests.

**Tests (Hakim).**

- A non-owner pushes a branch whose workflow posts `ApexYard Gate: success` on another PR's head SHA. GitHub must refuse the push.
- A PR changes a test script so that it posts `ApexYard Gate: success` with the job's token. The post must fail with 403, or the check must stay failed.

The remaining risk is a policy owner who approves a workflow change without reading it.

### 7. Distribution and the demo repository

Owner decision (2026-10-01):

- The demo repository is `me2resh/apexyard-demo`. It is public, in the owner's personal account, and empty now.
- `me2resh/apexyard-gate` becomes public (MIT) when gate v0 is ready. The demo repository then uses the Action by its full commit SHA, and branch rulesets are free.
- The gate is a JavaScript action on a Node.js runtime that GitHub Actions supports. The bundled `dist/` is committed, so a run needs no `npm install`.

Order of work: GitHub shares a private action only with private repositories of the same owner. So the public demo repository cannot run the gate until the gate repository is public. Before that, test the gate in a private test repository of the same owner.

The demo repository's accounts and roles are configured outside this public record.

The cloud's "Demo" team is a GitHub user-ID allowlist, not an org (a decision of the cloud signing service). It is separate from the repository location.

### 8. The invariant: no cloud call

- The gate's HTTP client accepts only the host `api.github.com`. A test fails the build on any other host.
- The gate reads the pinned pack. It never calls the ApexYard cloud (ac3-5).

## Consequences

- One required check proves, on the exact head SHA, that the PR links a ticket and has an approval from an allowlisted human who is not the author.
- The check records verified and reported facts apart. No verdict reads a reported fact.
- The PR under review cannot change the policy that judges it.
- The gate fails on a missing or bad pack, a missing `gate.json`, an unknown blocking rule and any gate error. Setup mistakes block merges, and the reason names the cause.
- The gate's safety depends on correct rulesets, CODEOWNERS and account roles. The installer (ac2-4) must set them up later. For the skeleton, the owner sets them by hand and the Hakim test proves them.
- Protected paths and the last-pusher condition are enforced by GitHub rulesets, not by the gate, in the skeleton.
- Review-triggered runs use the PR's workflow file. The push ruleset, or the credential fallback, closes that path.
- Only the gate workflow may hold `checks: write`. Every other workflow in the demo repository runs with a read-only token. This rule ends when the GitHub App identity arrives.
- On fork PRs, review events get a read-only token, so the check does not refresh after an approval. Fork PRs are out of scope.
- The Runner may show a newer pack than the pinned copy until the pack PR merges. The evidence names the pinned version.
- `pull_request_target` gives a write token even to fork PRs. A later change that adds a checkout of PR code would expose it. The template test guards against that.

## Out of scope

- Check C, protected paths in the gate (ac2-3).
- The last-pusher lookup in the gate.
- The full `gate.agdr_paths` rule (ac2-2, AgDR part).
- The installer and the agent-identity guide (ac2-4).
- Fork PRs and the `workflow_run` relay.
- A GitHub App identity for the check.
- Merge queues (`merge_group`).
- CI reviewer verdicts in the evidence.
- The false-block corpus and external adoption (ac2-6).

## Build tests (required)

Each case has a fixture and an expected verdict:

- Pass: linked open issue, approval on the head SHA by an allowlisted non-author.
- Fail: no linked issue. A linked issue in another repository only. A closed linked issue.
- Fail: approval by the author. Approval by a user not in `approvers`. Approval by a bot.
- Fail: approval on an older SHA. An approval followed by `CHANGES_REQUESTED` from the same reviewer. A dismissed approval.
- Fail: a `CHANGES_REQUESTED` review on the second page of reviews, after an approval on the first page.
- Fail: a tampered pack, an unsigned pack, an unknown `kid`, a missing pack, a missing `gate.json`.
- Fail: an unknown blocking rule. Pass with a note: an unknown advisory rule.
- Fail: an exception in the shell leaves `failure`, not an old `success`.
- Evidence: a record over 4 KB, a sixth record, a record with a backtick path, a record with unknown keys, a value with `|`, and an AgDR with `run:` outside the frontmatter.
- Template: no `actions/checkout`, no `${{ github.event.* }}` or `${{ github.head_ref }}` in `run:` or `script:`, the exact permissions set, the action pinned by SHA, and a job name other than `ApexYard Gate`.
- Network: any host other than `api.github.com` fails the test.
- Live setup (demo repository): the Hakim push test, the test-script post test, the non-default-base test, and a commit status named `ApexYard Gate` from a user token that does not satisfy the required check.
- AgDR-0002's live-check list supersedes the check-identity live tests in this list.
- Coverage of the evaluator above 80% (ticket #20).

## Artifacts

- PR me2resh/apexyard-gate#2 (this record).

## Revision 2026-10-01: default branch only

The gate reads policy only from the default branch. The gate fails any PR whose base is another branch. GitHub fills `closingIssuesReferences` for PRs into non-default branches too. The earlier statement in decision 3 is corrected. Rex and Hakim found this on PR #3.

## Revision 2026-10-02: pack schema v0

The gate validates packs against `schemas/pack.v0.json`. This schema matches the cloud pack shape. The earlier hand-written shape did not match the cloud output. The cloud repository pins a copy of this schema. It runs a producer-to-consumer test. The ORBIT reconcile of 2026-10-02 found the mismatch.

## Revision 2026-10-03: check identity (superseded in part by AgDR-0002)

Any account with write access can add a branch workflow that posts a passing check named `ApexYard Gate` as GitHub Actions (#9). [AgDR-0002](AgDR-0002-gate-check-identity.md) replaces three parts of this record: the gate job's `checks: write` permission, the `pull_request_review` trigger, and the instruction to pin the required check to the GitHub Actions app. The gate now posts its check as the adopter's own GitHub App, and the ruleset pins the check to that App. Everything else in this record stays.

## Glossary

| Term | Definition |
|------|------------|
| Gate | A GitHub Action that posts one required check proving the agreed process ran on the PR head commit. |
| Base branch | The branch the PR merges into. The gate reads its policy from that branch's head. |
| Head SHA | The commit at the tip of the PR branch. |
| Policy owner | A GitHub user named in CODEOWNERS for the protected paths, and on the push ruleset's bypass list. |
| Protected path | A file or folder that only a policy owner can approve or push changes to. |
| Evidence record | The check-run summary that lists facts about the PR, each labelled verified or reported. |
| Push ruleset | GitHub rules that refuse a push that changes named file paths. |
| Branch ruleset | GitHub rules that require checks and reviews before a merge to a branch. |
