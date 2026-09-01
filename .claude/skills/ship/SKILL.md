---
description: Land the session's work — feature branch, checks, review, small commits, push, terse PR.
disable-model-invocation: true
---

Take the working tree from "edited" to "PR open". Work through every step; the run is done when the PR URL is printed.

## 1. Feature branch

Run `git status` and `git branch --show-current`.

- On a feature branch: continue.
- On the default branch (`main`/`master`) with uncommitted changes: `git checkout -b <type>/<slug>`; the working tree moves with it.
- On the default branch with local commits ahead of `origin/<default>`: create the branch at `HEAD`, then reset the default branch back to `origin/<default>`.

Branch name: `feat/`, `fix/`, `chore/`, or `docs/` plus a two-to-four word kebab slug of the work.

## 2. Checks

Read `package.json` scripts (or the repo's equivalent) and run what exists, in this order: typecheck, lint, unit tests, integration tests. Missing scripts are skipped and named in the final report. A failing check is fixed before moving on; a failure you cannot fix stops the run with the output shown.

## 3. Review

Size the review to the diff. Run `git diff --stat origin/<default>` and pick the level:

- `low`: docs, config, or tests only; or under 50 changed lines in one file.
- `medium`: under 300 changed lines, one area of the code.
- `high`: 300 lines or more, or any touch to a load-bearing path: shared contracts and schemas, the write path, persistence, auth, or anything CLAUDE.md calls load-bearing.

Blast radius beats line count: a ten-line change to a schema is `high`.

Run `/code-review <level>`. Fix every finding that is a real defect in this branch's diff. Re-run step 2 if any fix touched code. Findings you chose to skip go in the final report, one line each.

## 4. Commits

Group the diff into logical units: one commit per concern (a core module and its test, a renderer change, a config change). Stage by path, never `git add -A`. Before staging an untracked file, check it is not a secret, a build artifact, or something `.gitignore` should cover.

Commit message: imperative subject under 70 characters, body only when the subject cannot carry the why.

## 5. Push and PR

`git push -u origin <branch>`. If a PR already exists for the branch (`gh pr list --head <branch>`), the push updates it and you report its URL. Otherwise `gh pr create` with:

- Title: the branch's one-line purpose.
- Body: what changed and why in three to six lines, then a "Verification" line naming which checks ran. Use the repo's PR template if one exists. Short beats complete.

## Report

Print: branch, PR URL, checks run and skipped, review findings skipped.
