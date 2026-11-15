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
| Pull request | CodeRabbit | — | AI review; the approval it posts is what satisfies the branch rule |
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

The environment has no required reviewer, so a merge deploys on its own. Add
one (Settings → Environments → `production`) to make every production deploy a
manual step.

### Other secrets this repository already uses

| Name | Scope | Used by |
| --- | --- | --- |
| `CRON_SECRET` | repository | `keep-alive.yml` — the hourly feed ingest |
| `E2E_DATABASE_URL`, `E2E_OWNER_EMAIL`, `E2E_OWNER_PASSWORD`, `E2E_BETTER_AUTH_SECRET`, `E2E_SIGNUP_INVITE_CODE` | the protected `e2e` environment | the Playwright job in `ci.yml` |

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
| `E2E against the production container` | the Neon `ci-e2e` branch was deleted or `E2E_DATABASE_URL` was repointed — the job says so in its log |

The e2e job needs an approval on the protected `e2e` environment before it
runs; that approval is a separate step from the merge approval.

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

### The e2e database disappeared

The Neon branch `ci-e2e` is a throwaway copy of the schema and is deleted
seven days after it was created. When it is gone the e2e job fails with
*Require the E2E database*. Recreate the branch, copy its connection string
into the `E2E_DATABASE_URL` secret of the `e2e` environment, and re-run the
pull request check.
