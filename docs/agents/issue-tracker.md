# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create, read, list, comment on, label, and close issues with `gh issue`.
- Infer the repository from `git remote -v`.
- Pull requests are not a triage request surface.
- When a skill says "publish to the issue tracker", create a GitHub issue.
- When a skill says "fetch the relevant ticket", run `gh issue view <number> --comments`.
- Wayfinder maps and child tickets use GitHub sub-issues and native issue dependencies where available, with task-list and `Blocked by:` fallbacks where unavailable.
