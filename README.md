# ApexYard Gate

ApexYard Gate posts one check on a pull request. The check name is `ApexYard Gate`. The check proves two facts about the head commit.

- The pull request links an open issue in the same repository.
- An allowlisted person approved that commit. That person is not the author. The account type is `User`.

The gate reads `.apexyard/pack.json`, `.apexyard/pack.json.sig`, and `.apexyard/gate.json` from the default branch through the GitHub API. On `pull_request_target`, a run for a PR whose base is not the default branch is refused with no check; the ruleset protects only the default branch. On the relay path, the base check still applies and fails such a PR. The gate checks the pack signature with a public key pinned in the gate. It accepts only the host `api.github.com`.

Status: v0.

## Inputs

| Name | Required | Meaning |
| --- | --- | --- |
| `token` | yes | The job's read-only token. The gate uses it for every repository, pull request, issue, content, review, and commit read. |
| `app-id` | yes | The adopter-owned GitHub App's ID. |
| `app-key` | yes | The adopter-owned GitHub App's private key. |

The template passes `${{ github.token }}` and the two App values from the protected `apexyard-gate` environment. The App token is used only to create and update check runs. It is masked immediately, is never written to a file or action output, and is limited to this repository with `checks: write`.

The action writes the output `verdict`. The value is `pass`, `fail`, or `error`. It reads the event file from `GITHUB_EVENT_PATH`. It loads the pull request again and uses the current head SHA.

The action exits with status 0 when the verdict is `pass`. It exits with status 1 when the verdict is `fail` or when the gate reports an error.

## Program layout

`action.yml` sets `runs.main` to `dist/index.js`. That file loads `src/main.js`. The action has no runtime dependencies. It uses Node.js built-in modules only. There is no compile step. GitHub runs the modules in `src/`.

The action runtime is `node24`.

## Workflow template

Copy both `templates/apexyard-gate.yml` and `templates/apexyard-gate-relay.yml` into the repository that you protect.

The workflow runs on these events.

- `pull_request_target`: `opened`, `reopened`, `synchronize`, `edited`, `ready_for_review`.
- `workflow_run`: completed runs of the `apexyard-gate-relay` workflow.

The relay workflow runs on `pull_request_review` (`submitted`, `edited`, `dismissed`). It has no permissions, secrets, or checkout; its completion causes the gate workflow to evaluate current pull request state from the default branch.

The gate job is named `apexyard-gate-evaluate`, and it alone references the `apexyard-gate` environment. Neither workflow checks out code or runs pull request code.

Replace the placeholder with the full 40-character commit SHA before use.

```yaml
uses: me2resh/apexyard-gate@<40-character SHA>
```

The gate job permissions are read-only: `contents: read`, `pull-requests: read`, and `issues: read`. It does not request `checks: write`; the adopter-owned App supplies that permission for posting only.

The concurrency group uses the pull request number for `pull_request_target`, or `workflow_run.head_sha` for a relay-triggered run, and cancels an older run in the same group.

## Policy files

Commit these files on the default branch.

`.apexyard/gate.json` lists numeric GitHub user ids.

```json
{
  "v": 1,
  "approvers": [12345678, 23456789]
}
```

`.apexyard/pack.json` and `.apexyard/pack.json.sig` hold the signed pack. The signature file has the shape `{"kid":"...","sig":"<base64 DER>"}`. The gate checks an ECDSA P-256 SHA-256 signature over the exact pack bytes.

`src/keys.js` pins the production public key `apexyard-pack-1`. The private key never leaves AWS KMS. To rotate, add the new `kid` here before packs are signed with it.

## Pack format

A pack uses `apexyard.pack/0`. The required fields and limits are defined in [`schemas/pack.v0.json`](schemas/pack.v0.json). The gate verifies the signature over the exact file bytes before it parses and validates the pack.

## App setup

Use a public repository or a private repository on a paid GitHub plan. Free-plan private repositories cannot protect the App key with environment deployment-branch rules, so they are not protected by this design.

1. Create a GitHub App owned by the adopter, for example `ApexYard Gate (owner)`. Disable the webhook. Give it only repository permissions `checks: write` and `statuses: write`. The gate does not use statuses, but GitHub requires that permission before a ruleset can pin a required check to the App.
2. Install the App only on the repositories that it will protect.
3. In each protected repository, create an environment named `apexyard-gate`. Change its deployment branches from **No restriction** to **Selected branches**, then add one **Branch** rule for the repository's default branch. Do not choose "Protected branches only". Do not add a Tag rule. This branch rule is the control that keeps the App key away from branch workflows.
4. Add environment secrets `APEXYARD_GATE_APP_ID` and `APEXYARD_GATE_APP_KEY`.
5. Commit `.apexyard/gate.json`, `.apexyard/pack.json`, `.apexyard/pack.json.sig`, and `CODEOWNERS` on the default branch. Set the repository's default workflow permissions to read-only.
6. Merge the gate and relay workflows from `templates/`. Let the App post `ApexYard Gate` once, then pin that required check's source to the adopter-owned App. Complete this pin before the agent account receives write access.
7. Restrict who can dismiss pull request reviews to the policy owners. Require Code Owner review for `.github/workflows/**` so a pull request cannot change or remove either workflow without a policy owner.
8. Run the live checks below.

The gate refuses to run unless the event is `pull_request_target` or `workflow_run` and `GITHUB_REF` is the default branch. On `pull_request_target`, this refuses a non-default-base run without posting a check; the ruleset protects only the default branch. On the relay path, the base check still fails any PR whose base is not the default branch. The gate also fails when the default branch has no pack or no `gate.json`.

The App has no webhook, so the Re-run button on its check does nothing; re-run the workflow instead. Every gate job creates a deployment record for the `apexyard-gate` environment.

Key rotation: generate a new App private key, replace `APEXYARD_GATE_APP_KEY`, then delete the old key. On a suspected compromise, delete the old key first; checks stop until the new key is in place.

## Rulesets

### Workflow permissions

1. Set the default workflow permissions to read-only.
2. Keep the gate workflow read-only. Do not grant `checks: write` or `statuses: write` to it or to another workflow.
3. Require Code Owner review for `.github/workflows/**`.

### Push ruleset

Apply a push ruleset on all branches.

1. Block a push that adds or changes `.github/workflows/**` or `.github/actions/**`.
2. Let only the policy owners bypass the ruleset.

GitHub likely offers push rulesets only on private and internal repositories. On a public repository, use this fallback.

1. Remove the `workflow` scope from the developer push credential. Check it with `gh auth status`. Remove it with `gh auth refresh --remove-scopes workflow`.
2. Add no SSH key on the developer account. An SSH push ignores OAuth scopes.

### Branch ruleset on main

1. Require the status check `ApexYard Gate`. Pin the source to the adopter-owned GitHub App.
2. Require one approval. Dismiss stale approvals on a new push. Require approval of the most recent reviewable push.
3. Restrict review dismissal to policy owners. Require review from Code Owners. Name the policy owners in `CODEOWNERS` for `.github/workflows/**`, `.github/actions/**`, `.apexyard/**`, `CODEOWNERS`, and `.github/CODEOWNERS`.
4. Block force pushes. Block deletion of the branch.
5. Use merge commits.

### Accounts

1. Pin the required `ApexYard Gate` check to the adopter-owned App before giving the account that runs the agent write access. Keep that account off the admin role and off every bypass list.
2. Run the agent from a collaborator account. On a personal-account repository, the owner is always an admin.
3. Name at least two policy owners in `CODEOWNERS`.
4. Give every approver and every policy owner write access.

## Evidence

The check summary is a table. A row has a fact, a value, and a label.

GitHub supplies the verified facts: head SHA, base SHA, pack signature, linked issue number, approver, and author. The gate shows a run-record fact as **reported**. No verdict reads a reported fact.

The gate reads at most five run records from `docs/runs/<run-id>.json` on the head SHA. It refuses a file larger than 4 KB. It shows an invalid record as `not reported`.

## Local tests

Run this command on Node.js 24 or newer. The command installs nothing.

```sh
node --test --experimental-test-coverage
```

## Live checks

Run these checks on the demo repository. This repository does not run them.

1. Forged check. A branch workflow on `push` requests `checks: write` and posts a passing `ApexYard Gate`. The required check pinned to the adopter-owned App stays unsatisfied.
2. Environment restriction. A branch workflow references environment `apexyard-gate` and tries to read `APEXYARD_GATE_APP_KEY`. The job is refused or receives no secret.
3. Review relay. Submit a review on a pull request. The relay completes, and the gate posts a new check on the current head SHA.
4. Fail closed. Uninstall the App. The gate run fails with one clear installation-lookup error line and posts no check.
5. Start overlapping gate runs on one head SHA with different conclusions and confirm that the newest check run is the result that the required check uses.

## Licence

MIT.
