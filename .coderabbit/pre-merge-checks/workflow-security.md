---
id: workflow-security
name: Workflow security
paths:
  - ".github/workflows/**"
mode: error
---

Workflow files decide what this repository's own automation is allowed to do.
Check every changed workflow against these three rules.

Fail if a changed workflow does any of the following:

1. It executes text that a pull request can influence — the pull request
   title, body, branch name, head ref or commit message — inside a `run:`
   block or as an input to another action. Interpolating
   `${{ github.event.pull_request.* }}` straight into a shell command lets a
   pull request run its own code in the runner. Values read from a file or
   from a numeric field such as the pull request number are safe.
2. It widens `permissions:` beyond what the job needs. The workflow-level
   default in this repository is `contents: read`; a job that needs more has
   to ask for the specific scope it uses, such as `packages: write` or
   `security-events: write`. `write-all` is never acceptable.
3. It can leak a secret into a log or into the output of a command:
   - printing a secret with `echo`, `printenv` or `env`,
   - running `curl` with `--verbose`, `-v` or `-i` against a URL that carries
     a token or an `Authorization` header,
   - writing a secret into `$GITHUB_OUTPUT` or into a job summary,
   - running a command that prints the whole environment.
   The secrets in this repository are `CRON_SECRET`, `KEEP_ALIVE_URL` and the
   `E2E_*` values that live in the protected `e2e` environment. Passing a
   secret to a command through an environment variable is fine; printing it is
   not.

Pass when none of the three apply. Name the workflow, the job and the line of
every failure and quote the offending line.
