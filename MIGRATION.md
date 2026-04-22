# Migration Guide: Pure Actions & Gitea Compatibility

This document outlines the changes made to migrate from GitHub App authentication to pure GitHub Actions and add Gitea compatibility.

## 2026-Q2: Unified run.ts entrypoint (drops `anthropics/claude-code-base-action@v0.0.63`)

**Who needs to read this:** maintainers of Gitea workflows that pin a specific commit/tag of this action. Typical end-user workflows need **no changes** — the public input surface is preserved.

### What changed

Before:

- `action.yml` ran a two-step pipeline:
  1. `src/entrypoints/prepare.ts` — built context, fetched data, wrote prompt, emitted `mcp_config` as a step output.
  2. `uses: anthropics/claude-code-base-action@v0.0.63` — external, frozen since Aug 2025, invoked Claude via CLI subprocess.

After:

- `action.yml` runs a single in-process orchestrator: `bun run src/entrypoints/run.ts`.
- `run.ts` imports `./base-action/src/*` directly (no external action, no subprocess boundary).
- Claude is invoked through the SDK wrapper (`runClaude` → `runClaudeWithSdk`).

The external pin is gone. The local `./base-action/` directory — previously kept in sync with upstream but unused — is now the live execution path.

### New inputs, now live

These inputs existed in `action.yml` as stubs and were plumbed as env vars but never reached Claude. They are wired through the unified entrypoint:

| Input                 | Purpose                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `show_full_output`    | Print the full JSON message stream from Claude. **WARNING**: exposes tool results (possibly secrets) in workflow logs. Use only for non-sensitive debugging. |
| `plugins`             | Newline-separated list of Claude Code plugin names to install before running (`installPlugins`).                                                             |
| `plugin_marketplaces` | Newline-separated list of plugin marketplace Git URLs.                                                                                                       |
| `display_report`      | Render Claude's turns as a Step Summary at the end of the run. `"false"` suppresses. Default `"true"`.                                                       |

### Input shape unchanged

All previously-supported inputs continue to work with the same names: `max_turns`, `timeout_minutes`, `model`, `system_prompt`, `append_system_prompt`, `fallback_model`, `allowed_tools`, `disallowed_tools`, `mode`, `claude_env`, `use_bedrock`, `use_vertex`, `ssh_signing_key`, `bot_id`, `bot_name`, etc. No `claude_args`-style migration is required.

### Behavior subtleties

- **Agent mode trigger source:** agent mode fires when `direct_prompt` or `override_prompt` is set (matching what `createAgentPrompt` actually consumes). The `prompt` input alone does **not** trigger agent mode on Gitea. Users who set `mode: agent` without one of those will see "No trigger found, skipping remaining steps" — use `direct_prompt` instead.
- **timeout_minutes:** honored via a `Promise.race` deadline in `run.ts`. The SDK path has no native per-invocation timeout; this shim preserves the published semantics.
- **execution_file on failure:** the SDK wrapper throws on non-success results after writing the execution log. `run.ts` captures the known `${RUNNER_TEMP}/claude-execution-output.json` path on catch so `update-comment-link` and the step-summary still see the debug log.
- **Cloud provider flags:** `use_bedrock: true` / `use_vertex: true` now export `CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1` (the names `validateEnvironmentVariables` keys off). Workflows relying on this without an Anthropic key now pass validation.
- **Removed dead paths:** the old `Mode` object abstraction (`src/modes/registry.ts`, `src/modes/types.ts`, object-shaped `tagMode`/`agentMode`) is deleted. Tests that imported them (`test/modes/*.test.ts`) are removed; new coverage sits in `test/build-claude-args.test.ts` and the existing prepareMcpConfig + trigger tests.

### If you vendored `src/entrypoints/prepare.ts`

It's gone. Entity-context flow lives in `src/modes/tag/index.ts#prepareTagMode`. Automation/agent flow lives in `src/modes/agent/index.ts#prepareAgentMode`. Both are invoked from `src/entrypoints/run.ts`.

---

## What Changed

### 1. Removed GitHub App Dependencies

- **Before**: Used OIDC token exchange with Anthropic's GitHub App service
- **After**: Uses standard `GITHUB_TOKEN` from workflow environment
- **Benefit**: No external dependencies, works with any Git provider

### 2. Self-Contained Implementation

- **Before**: Depended on external `anthropics/claude-code-base-action`
- **After**: Includes built-in Claude execution engine
- **Benefit**: Complete control over functionality, no external action dependencies

### 3. Gitea Compatibility

- **Before**: GitHub-specific triggers and authentication
- **After**: Compatible with Gitea Actions (with some limitations)
- **Benefit**: Works with self-hosted Gitea instances

## Required Changes for Existing Users

### Workflow Permissions

Update your workflow permissions:

```yaml
# Before (GitHub App)
permissions:
  contents: read
  pull-requests: read
  issues: read
  id-token: write

# After (Pure Actions)
permissions:
  contents: write
  pull-requests: write
  issues: write
```

### Required Token Input

Now required to explicitly provide a GitHub token:

```yaml
# Before (optional)
- uses: anthropics/claude-code-action@beta
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}

# After (required)
- uses: anthropics/claude-code-action@beta
  with:
    gitea_token: ${{ secrets.GITHUB_TOKEN }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Gitea Setup

### 1. Basic Gitea Workflow

Use the example in `examples/gitea-claude.yml`:

```yaml
name: Claude Assistant for Gitea

on:
  issue_comment:
    types: [created]
  issues:
    types: [opened, assigned]

jobs:
  claude-assistant:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'issues' && contains(github.event.issue.body, '@claude'))
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run Claude Assistant
        uses: ./ # Adjust path as needed for your Gitea setup
        with:
          gitea_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 2. Gitea Limitations

Be aware of these Gitea Actions limitations:

- **`issue_comment` on PRs**: May not trigger reliably in some Gitea versions
- **`pull_request_review_comment`**: Limited support compared to GitHub
- **GraphQL API**: Not supported - action automatically falls back to REST API
- **Cross-repository access**: Token permissions may be more restrictive
- **Workflow triggers**: Some advanced trigger conditions may not work
- **Permission checking**: Simplified for Gitea compatibility

### 3. Gitea Workarounds

#### For PR Comments

Use `issue_comment` instead of `pull_request_review_comment`:

```yaml
on:
  issue_comment:
    types: [created] # This covers both issue and PR comments
```

#### For Code Review Comments

Gitea has limited support for code review comment webhooks. Consider using:

- Regular issue comments on PRs
- Manual trigger via issue assignment
- Custom webhooks (advanced setup)

## Benefits of Migration

### 1. Simplified Authentication

- No OIDC token setup required
- Uses standard workflow tokens
- Works with custom GitHub tokens

### 2. Provider Independence

- No dependency on Anthropic's GitHub App service
- Works with any Git provider supporting Actions
- Self-contained functionality

### 3. Enhanced Control

- Direct control over Claude execution
- Customizable tool management
- Easier debugging and modifications

### 4. Gitea Support

- Compatible with self-hosted Gitea
- Automatic fallback to REST API (no GraphQL dependency)
- Simplified permission checking for Gitea environments
- Reduced external dependencies
- Standard Actions workflow patterns

## Troubleshooting

### Common Issues

#### 1. Token Permissions

**Error**: "GitHub token authentication failed"
**Solution**: Ensure workflow has required permissions:

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write
```

#### 2. Gitea Trigger Issues

**Error**: Workflow not triggering on PR comments
**Solution**: Use `issue_comment` instead of `pull_request_review_comment`

#### 3. Missing Dependencies

**Error**: "Module not found" or TypeScript errors
**Solution**: Run `npm install` or `bun install` to update dependencies

### Gitea-Specific Issues

#### 1. Authentication Errors

**Error**: "Failed to check permissions: HttpError: Bad credentials"
**Solution**: This is normal in Gitea environments. The action automatically detects Gitea and bypasses GitHub-specific permission checks.

#### 1a. User Profile API Errors

**Error**: "Prepare step failed with error: Visit Project" or "GET /users/{username} - 404"
**Solution**: This occurs when Gitea's user profile API differs from GitHub's. The action automatically detects Gitea and skips user type validation.

#### 2. Limited Event Support

Some GitHub Events may not be fully supported in Gitea. Use basic triggers:

- `issue_comment` for comments
- `issues` for issue events
- `push` for code changes

#### 3. Token Scope Limitations

Gitea tokens may have different scope limitations. Ensure your Gitea instance allows:

- Repository write access
- Issue/PR comment creation
- Branch creation and updates

#### 4. GraphQL Not Supported

**Error**: GraphQL queries failing
**Solution**: The action automatically detects Gitea and uses REST API instead of GraphQL. No manual configuration needed.

## Migration Checklist

- [ ] Update workflow permissions to include `write` access
- [ ] Add `github_token` input to action configuration
- [ ] Remove `id-token: write` permission if not used elsewhere
- [ ] Test with GitHub Actions
- [ ] Test with Gitea Actions (if applicable)
- [ ] Update any custom triggers for Gitea compatibility
- [ ] Verify token permissions in target environment

## Example Workflows

See the `examples/` directory for complete workflow examples:

- `claude.yml` - Updated GitHub Actions workflow
- `gitea-claude.yml` - Gitea-compatible workflow
