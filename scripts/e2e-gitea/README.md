# Gitea E2E harness

A disposable Gitea + `act_runner` stack that drives this action end-to-end.
Used during development to verify the merge from upstream and the Gitea-specific ports.
Committing it here so the next contributor doesn't rebuild from scratch.

## TL;DR

```bash
# bring up the stack, create users/repos, install the workflow
bun scripts/e2e-gitea/e2e.ts up

# set the Claude Code OAuth token (piped or typed at the prompt)
echo "sk-ant-oat01-…" | bun scripts/e2e-gitea/e2e.ts secret CLAUDE_CODE_OAUTH_TOKEN

# trigger + watch a run
bun scripts/e2e-gitea/e2e.ts trigger issue "smoke" "@claude reply briefly"
bun scripts/e2e-gitea/e2e.ts watch
```

Tear down when done:

```bash
bun scripts/e2e-gitea/e2e.ts down
```

## Prerequisites

- Docker daemon running
- Bun 1.x (already a repo prereq)
- A Claude Code OAuth token (`sk-ant-oat01-…`)

## What `up` creates

| Resource  | Identifier                    | Purpose                                                          |
| --------- | ----------------------------- | ---------------------------------------------------------------- |
| Container | `gitea-e2e`                   | Gitea 1.24 on `127.0.0.1:3030`                                   |
| Container | `gitea-runner-e2e`            | `act_runner` registered with Gitea                               |
| User      | `admin`                       | site admin, token → `.admin-token`                               |
| User      | `claude`                      | write-only collaborator, token → `.claude-pat` (acts as the bot) |
| User      | `contributor`                 | non-admin PR author (simulates a developer), token → `.contributor-token` |
| User      | `bob`                         | non-write user for `allowed_non_write_users` bypass tests        |
| Repo      | `admin/e2e-dummy`             | the repo the action is exercised against                         |
| Repo      | `admin/claude-code-action`    | mirror of this repo's `gitea` branch                             |
| Secret    | `CLAUDE_PAT`                  | set to claude's PAT; used by the installed workflow              |
| Secret    | `CLAUDE_CODE_OAUTH_TOKEN`     | you set this via `secret` subcommand                             |
| Workflow  | `.gitea/workflows/claude.yml` | installed into the test repo                                     |
| Label     | `claude-task`                 | on the test repo, for label-trigger tests                        |

All state lives under `scripts/e2e-gitea/` (data dirs + token files) and is gitignored.

## Scenario cheat sheet

Each of these was verified by this harness at least once.

```bash
# 1. Issue mention
e2e.ts trigger issue "t" "@claude hello" && e2e.ts watch

# 2. Issue comment
ISSUE=$(e2e.ts trigger issue "t" "plain body")
e2e.ts trigger comment $ISSUE "@claude hello"
e2e.ts watch

# 3. Assignee trigger (assign to claude user; assignee_trigger=@claude)
ISSUE=$(e2e.ts trigger issue "t" "plain body")
e2e.ts trigger assign $ISSUE claude
e2e.ts watch

# 4. Label trigger (label_trigger=claude-task)
ISSUE=$(e2e.ts trigger issue "t" "plain body")
e2e.ts trigger label $ISSUE claude-task
e2e.ts watch

# 5. Non-write user bypass (bob is in allowed_non_write_users)
# — bob can't open issues without being a collaborator, so we demonstrate via label
#   trigger-authored by admin but note the SECURITY WARNING fires when bob triggers
#   elsewhere. For a cleaner demo, see test logs from the original session.

# 6. Claude modifies a file + opens a PR
e2e.ts trigger issue "work" "@claude please add hello.md with body 'hi' and open a PR"
e2e.ts watch

# 7. Cross-author PR review (REQUEST_CHANGES)
PR=$(e2e.ts trigger push-pr feature/demo demo.txt "draft content")
e2e.ts trigger comment $PR "@claude review with event=REQUEST_CHANGES and leave one inline comment on demo.txt line 1"
e2e.ts watch
```

## Configuration

All knobs live in the `DEFAULTS` block at the top of `e2e.ts`. Override any of them via env vars for one invocation:

```bash
GITEA_HTTP_PORT=4040 bun scripts/e2e-gitea/e2e.ts up
```

## Debugging

- `bun scripts/e2e-gitea/e2e.ts status` — containers, latest 5 runs, open PRs.
- `docker logs gitea-e2e` / `docker logs gitea-runner-e2e` — raw logs.
- `curl -s -u admin:admin123! http://127.0.0.1:3030/admin/e2e-dummy/actions/runs/<N>/jobs/0/logs` — job logs for a specific run.

## Bugs this harness originally caught

The harness was built iteratively while hardening the Gitea port. Each of these bugs was found _because_ the E2E driver exercised the code path:

- `c59b341` — Gitea emits `action: label_updated` (not `labeled`); label trigger silently never fired.
- `2500868` — create-prompt path also needed to accept `label_updated`.
- `485b3fb` — permissions fallback was granting write to anyone who triggered a workflow (workflow token perms > actor perms). Fail-closed on Gitea's `query only their own` 403.
- `3f54fab` — collaborator endpoint 403s for the repo owner; short-circuit when actor == owner.
- `1ae9ace` — graceful handling of missing `/tmp/claude-execution-output.json` (pinned base-action depends on `jq`, absent from the runner image).

So the harness is both setup and regression net.

## Extending

- New trigger verbs → add a case to `trigger()` in `e2e.ts`.
- New gitea MCP tool or other action-side change → just push to the `gitea` branch and re-run `up` (it mirrors the current branch into the local Gitea).
- Changing workflow defaults → edit `workflow-template.yml`, rerun `up`.
