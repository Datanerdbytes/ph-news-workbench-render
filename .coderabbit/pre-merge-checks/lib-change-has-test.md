---
id: lib-change-has-test
name: Library change has a test
paths:
  - "lib/**"
mode: error
---

Helpers under `lib/` are unit-tested with vitest in a sibling `*.test.ts` file
next to them. A behaviour change that ships without a matching test update is
a regression waiting to happen.

Fail if either of the following is true:

1. The pull request changes the behaviour of a file under `lib/` that already
   has a sibling `*.test.ts` file, and that sibling test is not modified in
   the same pull request.
2. The pull request adds a new file under `lib/` that is not a test file, and
   adds no sibling `*.test.ts` file for it.

A change counts as a behaviour change when it edits the body of a function, a
constant that changes what the code does, a validation rule, an error message
that callers match on, or the conditions of a database query. Comments,
formatting, type annotations that do not change runtime behaviour, and renames
of local variables are not behaviour changes. An import edit is not a
behaviour change only while it does not change runtime behaviour — adding,
removing or altering an import that changes what the module loads or what it
does at run time is a behaviour change.

For a file under `lib/` that already existed before this pull request and has
no sibling test at all, do not fail the check; mention in the explanation that
the file has no test yet. A file this pull request adds is not exempt — rule 2
applies to it.

Name the file that changed and the test file that is missing or stale.
