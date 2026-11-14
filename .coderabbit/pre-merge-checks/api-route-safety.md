---
id: api-route-safety
name: API route safety
paths:
  - "app/api/**"
mode: error
---

Route handlers under `app/api/` are the app's public surface. Check every
changed route handler against these four rules.

Fail if a changed route handler does any of the following:

1. It queries the database at module scope — a top-level `await sql\`...\`` or
   any top-level call that runs a query — instead of inside the handler. The
   production build runs without a database, so an import-time query breaks it.
2. It reads or writes user-scoped data (drafts, posts, notifications,
   preferences, files, workspace records, scheduled posts) before it has
   verified the caller. Every helper fails in its own way, and the handler has
   to handle each shape before it touches data:
   - `requireUser` (`lib/session.ts`) returns `null` when there is no
     session. The handler answers `null` with `unauthorized()` — a 401.
   - `requireWorkspace` (`lib/session.ts`) returns `null` when there is no
     session, and `{ user, workspace }` otherwise.
   - `requireOwner` (`lib/session.ts`) returns `null` when there is no
     session, a 403 `NextResponse` when the caller is authenticated but is not
     a workspace owner, and `{ user, workspace }` otherwise. The handler
     returns that 403 response as it is, and answers `null` with
     `unauthorized()`.
   - `requirePlatformConnection` (`lib/publishing/connection.ts`) returns
     `{ response }` — a `NextResponse` to send back — when the caller has no
     usable platform connection, and `{ context }` on success. The handler
     checks `result.response` before it uses the context.
3. It reads or writes a resource that the request identifies — a route
   parameter, a query parameter, or an id in the body — without proving the
   caller may reach that resource. An id in the request identifies the row; it
   does not authorize access to it. The handler has to scope the read or write
   to the caller's own workspace, the way the rest of this repository does it:
   take the workspace from the verified session (`access.workspace.id`) and
   put it in the query's `WHERE` clause next to the id. A query that selects
   the row by the request's id alone, or that trusts a workspace id sent by
   the caller, fails this rule. A caller check on its own — `requireUser` in
   particular — does not satisfy it, because it says who is calling without
   saying what they may reach.
4. It logs, returns or otherwise exposes a raw access token, a refresh token
   or an app secret. The Facebook page token is encrypted at rest by
   `lib/facebook-token.ts` and must never leave the server in plaintext.

Pass when none of the four apply. Name the file and the line of every
failure and quote the offending line.
