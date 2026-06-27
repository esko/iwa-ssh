# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `esko/gosh`. Use the `gh` CLI from the repo root.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --limit 100 --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Apply or remove labels: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.**

External pull requests do not enter the issue-triage queue. Skills should operate on GitHub Issues unless explicitly asked to inspect a pull request.

## Current planning surface

The active parent planning issue should point to `docs/LEGACY_PWA_PIVOT_PRD.md`. Implementation issues should reference that parent and should be small enough for one agent/worktree.

Before publishing new issues, check open issues to avoid duplicating reset tickets from the older near-upstream/xterm plan.

## Skill terminology

When a skill says "publish to the issue tracker," create a GitHub issue. When it says "fetch the relevant ticket," run `gh issue view <number> --comments`.
