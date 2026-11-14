---
id: api-route-safety
name: API route safety
paths:
  - "app/api/**"
mode: error
---

Route handlers under `app/api/` are the app's public surface. Check every
changed route handler against these three rules.

Fail if a changed route handler does any of the following:

1. It queries the database at module scope — a top-level `await sql\`...\`` or
   any top-level call that runs a query — instead of inside the handler. The
   production build runs without a database, so an import-time query breaks it.
2. It reads or writes user-scoped data (drafts, posts, notifications,
   preferences, files, workspace records, scheduled posts) before it has
   verified the caller. The verification helpers are `requireUser`,
   `requireWorkspace` and `requireOwner` in `lib/session.ts`, and
   `requirePlatformConnection` in `lib/publishing/connection.ts`. Each one
   returns `null` when the caller is not allowed, so the handler has to check
   that result before touching data.
3. It logs, returns or otherwise exposes a raw access token, a refresh token
   or an app secret. The Facebook page token is encrypted at rest by
   `lib/facebook-token.ts` and must never leave the server in plaintext.

Pass when none of the three apply. Name the file and the line of every
failure and quote the offending line.
