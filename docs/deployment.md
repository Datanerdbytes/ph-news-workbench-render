# Deployment pipeline

The app is deployed to Render by GitHub Actions. Nothing deploys from a pull
request, and nothing deploys unless the CI run on `main` is green.

```
feature branch
   │  pull request
   ▼
CI (ci.yml)  +  CodeRabbit review  ──►  human approval  ──►  merge
                                                                     │
                              main push                                │
                                   ▼                                   │
                   CI again (deploy.yml → ci.yml)                    │
                                   ▼                                   ▼
                        Deploy to Render  ──►  health check  ──►  live
```

| Stage | Workflow | Job | What it does |
| --- | --- | --- | --- |
| Pull request | `ci.yml` | `static`, `test`, `docker`, `e2e` | Lint, types, unit tests, image build + Trivy scan, Playwright against the image |
| Pull request | CodeRabbit | — | AI review, informational only — it never approves or blocks; the required CI checks and a human approval gate the merge |
| Merge to `main` | `deploy.yml` | `resolve` | Picks the one commit the whole pipeline works on |
| Merge to `main` | `deploy.yml` | `ci` | The same CI, run as a reusable workflow |
| Merge to `main` | `deploy.yml` | `deploy` | Triggers the Render deploy, waits for it to go live, checks the health endpoint |

The `deploy` job depends on `ci` with `needs:`, so a red CI run stops the
deploy before Render is ever told to build anything.

One commit runs the whole pipeline. The `resolve` job validates it once and
hands it to CI (as the checkout ref and the image tag) and to Render (as
`commitId`), so the code that was tested is the code that ships. A manual run
can name a different commit; the same commit is still the one CI checks and
the one Render builds.

The `deploy` job only runs on `main` (`if: github.ref == 'refs/heads/main'`).
A manual run from another branch runs the CI but never touches the live
service.

## Why the API and not the deploy hook

A failed Render build leaves the **previous** version serving, so the health
endpoint answers 200 either way — a hook alone cannot tell "deployed" from
"never deployed". The Render API reports the deploy's own status
(`build_failed`, `update_failed`, `live`, …), so the workflow can fail on a
broken build instead of reporting a green run against an unchanged app.

`scripts/render-deploy.mjs` pins the deploy to one commit (`commitId`), polls
the deploy until it is `live`, and then checks that the commit that went live
is the commit that was asked for.

## Required GitHub settings

### `production` environment secret

| Name | Value |
| --- | --- |
| `RENDER_API_KEY` | A Render API key — Render → Account settings → API Keys → *Create API key*. The value is shown once. |

### `production` environment variables

| Name | Value | Required |
| --- | --- | --- |
| `RENDER_SERVICE_ID` | `srv-dbrultd6e07s738ai8qg` | yes |
| `RENDER_HEALTH_URL` | `https://ph-news-workbench.onrender.com/login` | no (defaults to this) |
| `RENDER_DEPLOY_TIMEOUT_MINUTES` | `30` | no (defaults to this) |
| `RENDER_HEALTH_TIMEOUT_MINUTES` | `10` | no (defaults to this) |

These live in the `production` **environment**, not at repository scope, and
the `deploy` job is the only job that declares that environment. A pull
request can rewrite a workflow, so anything stored at repository scope is
readable by a pull request's own code. Scoping the Render credentials to the
environment keeps them out of reach of every pull request workflow — the
`deploy` job of the `main` workflow is the only place they are released.

The environment also needs a **deployment branch rule**: Settings →
Environments → `production` → *Deployment branches and tags* → *Selected
branches and tags* → add `main`. Without it the environment's secrets and
variables are released to a job that runs from any branch, which is exactly
what the environment is supposed to prevent.

The environment has no required reviewer, so a merge deploys on its own. Add
one (Settings → Environments → `production` → *Required reviewers*) to make
every production deploy a manual step.

### Other secrets this repository already uses

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:4c69199779f2544879fd2c41e35fb33314e6b0c72917dd370e4941e880111ddf -->

| Name | Scope | Used by |
| --- | --- | --- |
| `CRON_SECRET` | repository | `keep-alive.yml` — the hourly feed ingest |
| `E2E_OWNER_EMAIL`, `E2E_OWNER_PASSWORD`, `E2E_BETTER_AUTH_SECRET`, `E2E_SIGNUP_INVITE_CODE` | `e2e` | the Playwright job in `trusted-e2e.yml` |
| `NEON_API_KEY` | `e2e-db-management` only | creates and deletes temporary Neon branches |
| `E2E_DATABASE_URL` (optional) | `e2e-db-management` | uses a healthy test database instead of creating a branch |
| `E2E_DB_HANDOFF_KEY` | `e2e-db-management` and `e2e` | encrypts the database URL between jobs |

<!-- /coderabbit-ai-generated:v1 -->

## Required Render configuration

| Setting | Value | Why |
| --- | --- | --- |
| Runtime | Docker (`./Dockerfile`, context `./`) | the image the CI builds is the image that ships |
| Branch | `main` | the deploy pins a commit on this branch |
| Health check path | `/login` | answers 200 without a session; the workflow checks the same path |
| Auto-Deploy | **No** | GitHub Actions is the only deploy trigger — see below |

### Turning off Auto-Deploy

Render's own Auto-Deploy fires on every push to `main`. With GitHub Actions
deploying as well, one merge would build the same commit twice and burn free
build minutes, and — worse — the two deploys would race.

Turn Auto-Deploy off **after** the first GitHub Actions deploy has succeeded:

1. Render → the service → **Settings** → **Deploy** → **Auto-Deploy** → *Edit*.
2. Set it to **No** and save.

Until that is done, both mechanisms deploy and the app is unaffected — only
build minutes are wasted. The change is reversible from the same screen.

> The workspace's *Deploy Policy* decides what happens when two deploys
> overlap. If it is set to *Cancel*, one of the two deploys is cancelled —
> which is another reason to turn Auto-Deploy off rather than leave both on.

## Manual rollback

Render keeps every deploy, so a rollback is a dashboard action:

1. Render → the service → **Deploys**.
2. Open the last deploy that was healthy.
3. **Rollback** — Render rebuilds and redeploys that commit.

The same thing is available through the API
(`POST /v1/services/{serviceId}/rollback`), but the dashboard is the path
that needs no credentials. A rollback is a deploy like any other: it does not
go through GitHub Actions, and it does not wait for CI.

## Troubleshooting

### A pull request check is red

| Job | Common cause |
| --- | --- |
| `Static analysis & lint` | an ESLint error, a type error, or a dependency advisory that reached the blocking floor (`npm audit --audit-level=critical`) |
| `Unit & integration tests` | a failing vitest test |
| `Docker build & scan` | the image failed to build, or Trivy found a HIGH/CRITICAL vulnerability that has an upstream fix |
| `E2E against the production container` | the Neon API calls failed or the freshly created branch never became connectable — the job says so in its log |

The e2e job needs an approval on the protected `e2e` environment before it
runs; that approval is a separate step from the merge approval. A job that
sits in `waiting` for that approval is holding the Trusted E2E concurrency
lock — see [A superseded E2E run](#a-superseded-e2e-run).

### The deploy job failed

The job's log names the stage that failed:

- `the deploy did not go live: the Docker build failed` — the image does not
  build on Render's builder. Open the deploy in the dashboard
  (the log prints its URL) and read the build log there.
- `the deploy did not go live: the deploy failed while the new instance was
  starting` — the image built but the service did not come up. Check the
  service's **Logs** tab and the environment variables.
- `the deploy did not finish within the timeout` — the build was still running
  when the timeout hit. Raise `RENDER_DEPLOY_TIMEOUT_MINUTES` and re-run the
  workflow.
- `did not become healthy in time` — the deploy went live but the app does
  not answer on the health path. Check the service logs; a missing or wrong
  environment variable is the usual cause.
- `Render API POST ... failed with 401` — the API key is wrong or was
  regenerated in Render. Create a new one and update `RENDER_API_KEY`.

A deploy that queues behind another one is created but not started yet, and
Render answers the request with `202` and an empty body. The script then finds
that deploy in the service's deploy list and waits for it like any other, so a
queued deploy is normal and not a failure.

### Re-running a deploy

**Actions → Deploy → Run workflow** re-runs the pipeline from the selected
branch. The optional *commit* input deploys a specific commit sha instead of
the branch head — useful for redeploying the commit that is already live.

### A superseded E2E run

A push to a pull request makes every Trusted E2E run for that pull request
obsolete: it tests a merge commit that no longer exists. `trusted-e2e.yml`
queues its runs behind the `trusted-e2e-database` concurrency lock, and a run
waiting for an approval on the protected `e2e` environment holds that lock
until it times out — so a stale run parked at that approval gate keeps the run
for the current head from starting at all. The `e2e` job in `ci.yml` then
polls for a trusted run that structurally cannot begin, and the pull request
stays red until the poll runs out.

`trusted-e2e-supersede.yml` cancels those obsolete runs on every push. It runs
on `pull_request_target`, so it executes the version of the file on `main`, and
it sits outside the concurrency group so it can start while the run it cancels
is still holding the lock. Cancelling is not abandoning: the cancelled run's
cleanup job still runs on `always()` and deletes the Neon branch it
provisioned, so the lock is only released after that branch is gone.

If a run is still stuck — an approval nobody gave, or a run that predates this
workflow — cancel it by hand:

**Actions → Trusted E2E → the run → Cancel workflow**. Its cleanup job deletes
the branch it created, and the run for the current head starts as soon as the
lock is free. The `e2e` job in `ci.yml` then finds it and goes green; if that
job already timed out, re-run just that job.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:b00f335f20815727cefbde4ea8e2c90bf0f435eb0d2b8051fc16f08ed3b3f616 -->

### The e2e database

CI builds and scans the production image. For same-repository PRs to `main`,
the base workflow `trusted-e2e.yml` runs Playwright against the image for the
exact PR merge commit. The required E2E job in `ci.yml` waits for that result.
Keep the existing E2E check required.

#### One-time rollout

1. Create `e2e-db-management` and restrict deployment to the **branch** `main`
   only. Set `NEON_PROJECT_ID` and `NEON_PARENT_BRANCH_ID` as environment
   variables for an isolated Neon test project, with a parent the test runner
   can clone. Use a Neon key for that project. PR code receives the resulting
   database login, so the project and any optional URL must contain only
   disposable test data and must not share credentials with production.
2. Put `NEON_API_KEY` and the optional `E2E_DATABASE_URL` in
   `e2e-db-management` and remove them from `e2e` and other scopes accessible
   from PR workflows. Add the **same** fresh `E2E_DB_HANDOFF_KEY` to both
   environments; generate it with `openssl rand -hex 32`. Keep the Playwright
   reviewer on `e2e`. Cleanup must be able to run without another approval,
   so protect `e2e-db-management` by branch rather than requiring a reviewer
   on it.
3. Land `trusted-e2e.yml` and its scripts on `main` through a maintainer
   bootstrap change before switching the required job in `ci.yml` to wait for
   it. The PR copy cannot start a trusted run. Drain legacy database jobs
   before the switch, then update the PR to trigger both workflows. For a
   retry after cleanup, rerun **all jobs** in Trusted E2E so provisioning runs
   again, then rerun the required CI check if it already completed.

Provisioning reuses a healthy override; otherwise it creates a run-specific
branch, resets its schema, and passes only an encrypted connection string to
the Playwright job. The base checkout handles teardown even if provisioning
or testing fails, provided creation returned a branch ID. If a runner is
lost before cleanup, the next provisioner sweeps the orphan. The workflow
queues runs so the sweep cannot delete an active run's branch.

<!-- /coderabbit-ai-generated:v1 -->
