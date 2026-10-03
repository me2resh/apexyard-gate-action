---
id: AgDR-0002
timestamp: 2026-10-03T08:33:10Z
agent: claude
model: claude-opus-5-5
trigger: user-prompt
status: accepted
category: security
projects: [apexyard-gate]
---

# The gate posts its check as the adopter's own GitHub App

> In the context of a required `ApexYard Gate` check, facing the fact that any account with write access can add a branch workflow that posts a passing check with the same name, I decided that the gate posts its check as a GitHub App that the adopter owns, with the App key in an environment restricted to the default branch and the required check pinned to that App, to achieve a check that an account with write access cannot forge, accepting a medium setup cost for adopters, a setup step that adopters must not skip, and no protection on free-plan private repositories.

- **Ticket**: #9.
- **Supersedes**: the check-identity parts of AgDR-0001: the job's `checks: write` permission, the `pull_request_review` trigger, and the README instruction to pin the required check to the GitHub Actions app. Everything else in AgDR-0001 stays.
- **Reviews**: Hakim (Security Auditor) threat analysis, 2026-10-03. Tariq (Solution Architect) design review, 2026-10-03, round 1 findings B1 to B4 addressed here.
- **Related**: the code-review agent must post as its own GitHub App, so that its reviews are Bot reviews (me2resh/apexyard#1538).

## Context

- A live test showed that `pull_request_review` runs the workflow file from the PR branch, not from the default branch.
- The bypass is wider than that event (Hakim, with GitHub documentation):
  - `pull_request`, `pull_request_review`, `push`, `create` and `workflow_dispatch` all run a workflow file that is on a branch.
  - A workflow's `permissions:` key can request `checks: write` on a same-repository branch. A read-only repository default is only a default.
  - Every workflow token belongs to the one GitHub Actions app. A forged check and the real gate check have the same source.
  - Any account with write access can read every repository secret.
- A required check can name its source app. A check from any other app does not satisfy it.
- An environment's deployment-branch rule is matched against `GITHUB_REF`. That ref is the default branch only for `pull_request_target` and `workflow_run`. So branch code cannot read an environment secret that is restricted to the default branch.
- GitHub creates a new environment with **no deployment-branch restriction**. The restriction is a separate setup step.
- Environments with branch rules exist on every public repository, and on private repositories only on paid plans. Push rulesets exist only for private and internal repositories.
- AgDR-0001 decision: the ApexScript cloud is never in the merge path.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **(a) The adopter's own GitHub App posts the check.** Key in an environment restricted to the default branch. Required check pinned to that App. A relay workflow re-runs the gate after reviews. | Closes the bypass on public repositories and on paid plans. Branch code cannot reach the key, and its forged check comes from the wrong app. The cloud stays out of the merge path. | Medium setup for each adopter. The environment restriction is a manual step; if it is skipped, the bypass stays open. The gate must mint App tokens. No protection on free-plan private repositories. |
| (b) Relay workflow only, no App | Small change. Fixes the review-event path. | Does not close the bypass. Every other branch workflow can still post the check as GitHub Actions. |
| (c) A hosted ApexScript App posts the check from a server | One-click install. Also covers fork PRs. | Puts the cloud in the merge path, which reverses AgDR-0001. A server outage blocks merges. One key compromise affects every adopter. The gate becomes a server. |
| (d) Credential controls only: no `workflow` scope on the agent's credential, a push ruleset on workflow paths, CODEOWNERS | No code change. | Does not close the bypass on public repositories. CODEOWNERS acts too late, because a branch workflow runs before any merge. Nothing checks the credential scope, and SSH pushes ignore scopes. |

## Decision

Chosen: **(a) the adopter's own GitHub App, with a relay for reviews**, because it is the only option that closes the bypass on public repositories and on paid plans while it keeps the cloud out of the merge path. Option (d) stays as defence in depth.

### 1. Identity

1. Each adopter creates its own GitHub App, for example "ApexYard Gate (owner)". It has no webhook.
2. App permissions: `checks: write` and `statuses: write` only.
   - `checks: write` lets the App create the check run.
   - `statuses: write` is not used by the gate. GitHub requires it before a ruleset can pin a required check to an App.
   - All reads (pull request, contents, issues, reviews) use the workflow job's own read-only token, as today.
3. The adopter installs the App on the protected repositories only.
4. There is no shared ApexScript App key. A shared key would let any adopter post the check in every other adopter's repository.

### 2. Key storage (the main control)

1. The App ID and private key are secrets in a GitHub environment named `apexyard-gate`: `APEXYARD_GATE_APP_ID` and `APEXYARD_GATE_APP_KEY`.
2. **The adopter must change the environment's deployment branches from the default "No restriction" to "Selected branches", with one Branch rule for the default branch.** This rule is what keeps the key away from branch code. If it is missing, a branch workflow that references the environment can read the key, mint a token and post a passing check as the App.
3. Only the gate job references the environment. A template test checks this.
4. The gate's own refusal check (section 3.5) cannot stop an attacker, because an attacker's workflow runs its own code. It only catches setup mistakes in the adopter's real workflow.
5. A live check proves the restriction (see Build tests).

### 3. Token

1. The workflow passes the two secrets to the action as inputs `app-id` and `app-key`. The template test that forbids `secrets.` changes: it allows exactly these two references, only in the gate job.
2. The gate builds an RS256 JWT with Node.js built-in modules only: `iat` = now minus 60 seconds (clock skew), `exp` = now plus 9 minutes (GitHub allows at most 10), `iss` = the App ID.
3. The gate finds the installation with `GET /repos/{owner}/{repo}/installation`, signed with the JWT.
4. The gate requests `POST /app/installations/{id}/access_tokens` limited to the one repository and to `checks: write`.
5. The gate refuses to run unless `GITHUB_REF` is the default branch and the event is `pull_request_target` or `workflow_run`.
6. The gate masks the token in the log and never writes it to a file or an output. The token expires after one hour; the gate does not revoke it early.
7. **Failure:** if the JWT, the installation lookup or the token request fails, the gate cannot post a check. The required check then stays missing, so the merge stays blocked (fail closed). The workflow run fails with one clear error line that names the failed step. This is the expected result when the App is not installed or the key is wrong.
8. The workflow job keeps only read permissions. It no longer requests `checks: write`.

### 4. Triggers

1. `pull_request_target` on `opened`, `reopened`, `synchronize`, `edited` and `ready_for_review`, as before.
2. The template removes `pull_request_review` from the gate workflow.
3. A separate relay workflow named `apexyard-gate-relay` runs on `pull_request_review` (`submitted`, `edited`, `dismissed`) with `permissions: {}`. It has one step that does nothing that needs a token.
4. The gate workflow runs on `workflow_run` for workflow `apexyard-gate-relay`, type `completed`, with no filter on the relay's result. `workflow_run` runs from the default branch.
5. On `workflow_run`, the gate resolves PRs from `workflow_run.head_sha` with `GET /repos/{owner}/{repo}/commits/{sha}/pulls`. It trusts nothing else in the payload. It skips PRs that are not open. It evaluates at most 5 PRs and logs any that it drops. With zero open PRs, it exits without posting. It then loads each PR again and uses the current head SHA, as before.
6. A forged relay with the same name can only cause an extra evaluation of live state. That is harmless.
7. The concurrency group uses the PR number when the event has a PR, and the head SHA on `workflow_run`. Two runs for one PR can overlap. **Assumption to confirm by live check:** the newest check run on the head SHA is the result that counts.

### 5. Ruleset

1. The branch ruleset requires the status check `ApexYard Gate` with its source set to the adopter's App.
2. A check from GitHub Actions, or from any other app, does not satisfy the requirement. A forged Actions check stays visible next to the real one, but it does not count.
3. Order of setup and cutover:
   1. Create and install the App. Create the environment, set the Branch rule, add the two secrets.
   2. Merge the new gate workflow and relay. The App posts its first check.
   3. Pin the required check to the App. Until this step, a new install is unprotected; an existing install keeps the GitHub Actions pin, which blocks merges until the switch (no open window).
   Adopters pin the required check to the App before the agent account gets write access.
4. Restrict who can dismiss pull request reviews to the policy owners (branch protection "restrict who can dismiss reviews", or the ruleset equivalent where available).
5. Keep Code Owner review on `.github/workflows/**`, so that a PR cannot delete or change the relay or the gate workflow without a policy owner.

### 6. Free-plan private repositories

No option closes the bypass there: environments with branch rules and push rulesets are not available. This is accepted for the private test phase only. The README states that a production install needs a public repository or a paid plan.

## Consequences

- An account with write access can still push a workflow that posts a check named `ApexYard Gate`. That check comes from GitHub Actions, so it does not satisfy the required check.
- **Stale result after a review change.** A dismissed review, or a new "changes requested" review, does not change the head SHA. The old `success` stays on the PR until the relay run finishes, and stays if the relay run never finishes. The ruleset's own approval rule does not close this gap, because it does not check the approver allowlist: an allowlisted approval, then a dismissal, then an approval from a collaborator who is not on the list would satisfy the ruleset while the old `success` remains. Mitigations: section 5.4 (only policy owners can dismiss reviews) and section 5.5 (the relay cannot be removed without a policy owner). The residual risk is a relay run that fails or waits; the next push or PR edit re-runs the gate.
- Other residual risks:
  - a workflow on the default branch that runs PR code and also references the environment (the template test and Code Owner review cover this);
  - a policy owner who merges a harmful workflow;
  - repository admins, who can change rulesets and environments;
  - an account with write access that cancels a relay or gate run, which keeps the previous result until the next push or PR edit (this was already possible before);
  - an adopter who skips the environment Branch rule (section 2.2; the live check in Build tests detects it).
- Fork PRs: `pull_request_target` runs for fork PRs, so those jobs now load the App key. This is acceptable only while the template rules hold (no checkout, no event fields in a shell). Fork support through the relay is not claimed until a test confirms that the commits endpoint returns fork PRs. A fork's relay run can wait for maintainer approval, which keeps the old result.
- The Re-run button on the App's check does nothing, because the App has no webhook. Re-run the workflow instead.
- Each gate run creates a deployment record for the `apexyard-gate` environment.
- **Rollback:** revert the adopter's template change, then pin the required check back to GitHub Actions. That restores AgDR-0001's behaviour and its known gap.
- **Key rotation and compromise:** generate a new App private key, replace `APEXYARD_GATE_APP_KEY`, then delete the old key in the App settings. On a suspected compromise, delete the key first; checks stop until the new key is in place (fail closed). A key works only on the repositories where that adopter installed the App.

## Build tests (required)

- Unit: JWT claims (`iat` 60 seconds early, `exp` at most 10 minutes, `iss`); installation lookup; token request limited to the repository and `checks: write`; each failure path produces one error line and no check.
- Unit: refusal when `GITHUB_REF` is not the default branch, and for any event other than `pull_request_target` or `workflow_run`.
- Unit: `workflow_run` path: PR resolution by head SHA, skip non-open PRs, cap at 5, zero PRs posts nothing; concurrency key per event type.
- Unit: the token never reaches a log line, a file or an output.
- Template: only the gate job references the environment; only `app-id` and `app-key` use `secrets.`; the gate job has no write permission; the relay has `permissions: {}`; no checkout in any job.
- Live, on the demo repository:
  1. A branch workflow on `push` with `checks: write` posts a passing `ApexYard Gate`. The pinned required check stays unsatisfied.
  2. A branch workflow references environment `apexyard-gate` and tries to read `APEXYARD_GATE_APP_KEY`. The job is refused or gets no secret.
  3. A review submitted on a PR triggers the relay, and the gate posts a new check on the head SHA.
  4. With the App uninstalled, the gate run fails with one clear error line and posts no check.
  5. Start overlapping gate runs on one head SHA with different conclusions and confirm that the newest check run is the result that the required check uses.

## Artifacts

- Security analysis: Hakim, 2026-10-03 (posted on #9).
- Design review: Tariq, 2026-10-03, on PR #11.
- Implementation: the PR that closes #9.
