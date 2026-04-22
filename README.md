# Claude Code Action for Gitea

> This project is a Gitea-compatible fork of [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action), building on [markwylde/claude-code-gitea-action](https://github.com/markwylde/claude-code-gitea-action). Huge thanks to [Anthropic](https://github.com/anthropics) and [Mark Wylde](https://github.com/markwylde) for doing most of the heavy lifting — this fork builds on their work to add first-class Gitea support.

![Claude Code Action in action](assets/preview.png)

A Gitea action that provides a general-purpose [Claude Code](https://claude.ai/code) assistant for PRs and issues that can answer questions and implement code changes. It listens for a trigger phrase in comments and activates Claude to act on the request. Supports multiple authentication methods including Anthropic direct API, Amazon Bedrock, and Google Vertex AI.

> **Note**: This action is designed specifically for Gitea installations, using local git operations for optimal compatibility with Gitea's API capabilities.

## Features

- 🤖 **Interactive Code Assistant**: Claude answers questions about code, architecture, and programming
- 🔍 **Code Review**: Analyzes PR changes and files inline review comments (Copilot-style) with optional "Fix this →" links
- ✨ **Code Implementation**: Implements fixes, refactors, and new features; commits via local git for Gitea API compatibility
- 💬 **PR/Issue Integration**: Triggers on `@claude`, issue/PR assignment, or labels; reuses a single tracking comment per thread
- 🧑‍🔧 **Bot Identity**: Configurable commit attribution via `bot_id` / `bot_name` for Gitea's noreply email format
- 🛠️ **Flexible Tool Access**: Base Gitea + local-git-ops MCP tools; extend via `allowed_tools` or install Claude Code plugins
- 📋 **Progress Tracking**: Live checkbox updates in the tracking comment; full execution turn report rendered to Step Summary
- ☁️ **Multiple Providers**: Anthropic API, Claude Code OAuth, AWS Bedrock, Google Vertex AI

## Quick Start with Claude Code Plugin

If you use [Claude Code](https://claude.ai/code), you can generate workflows interactively:

```bash
/plugin marketplace add nllptrx/claude-code-action
/plugin install gitea-ci@gitea-ci-workflows
/gitea-ci
```

This walks you through selecting a workflow type, configuring it for your project, and writing it to `.gitea/workflows/`. See [available workflow types](#available-workflow-types) below.

## Setup

**Requirements**: You must be a repository admin to complete these steps.

1. Add `ANTHROPIC_API_KEY` to your repository secrets
2. Add `GITEA_TOKEN` to your repository secrets (a personal access token with repository read/write permissions)
3. Copy the workflow file from [`examples/gitea-claude.yml`](./examples/gitea-claude.yml) into your repository's `.gitea/workflows/`
   — or use the plugin above to generate one automatically

## Usage

Add a workflow file to your repository (e.g., `.gitea/workflows/claude.yml`):

```yaml
name: Claude Assistant
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned, labeled]
  pull_request_review:
    types: [submitted]

jobs:
  claude-response:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: nllptrx/claude-code-action@gitea
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }} # if you want to use direct API
          gitea_token: ${{ secrets.GITEA_TOKEN }} # can be a dedicated bot account's token
          claude_git_name: Claude # optional
          claude_git_email: claude@anthropic.com # optional
```

## Inputs

| Input                            | Description                                                                                                                                                                                       | Required | Default                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------- |
| **Trigger & Routing**            |                                                                                                                                                                                                   |          |                        |
| `trigger_phrase`                 | The trigger phrase to look for in comments, issue/PR bodies, and issue titles                                                                                                                     | No       | `@claude`              |
| `assignee_trigger`               | The assignee username that triggers the action (e.g. @claude). Only used for issue and PR assignment                                                                                              | No       | -                      |
| `label_trigger`                  | The label that triggers the action (e.g. `claude`)                                                                                                                                                | No       | `claude`               |
| `mode`                           | Execution mode: `tag` (default) or `agent`                                                                                                                                                        | No       | `tag`                  |
| **Branch & Base**                |                                                                                                                                                                                                   |          |                        |
| `branch_prefix`                  | Prefix for Claude branches (e.g. `claude/` or `claude-`)                                                                                                                                          | No       | `claude/`              |
| `base_branch`                    | Branch to use as base when creating new branches (defaults to repository default branch)                                                                                                          | No       | -                      |
| `branch_name_template`           | Template for generated branch names. Placeholders expanded by `src/utils/branch-template.ts`                                                                                                      | No       | `""`                   |
| **Authentication**               |                                                                                                                                                                                                   |          |                        |
| `anthropic_api_key`              | Anthropic API key (required for direct API, not needed for Bedrock/Vertex)                                                                                                                        | No\*     | -                      |
| `claude_code_oauth_token`        | Claude Code OAuth token (alternative to `anthropic_api_key`)                                                                                                                                      | No       | -                      |
| `gitea_token`                    | Gitea token with repo and pull request permissions                                                                                                                                                | No       | -                      |
| **Claude Code Configuration**    |                                                                                                                                                                                                   |          |                        |
| `model`                          | Model to use (provider-specific format required for Bedrock/Vertex)                                                                                                                               | No       | -                      |
| `anthropic_model`                | **DEPRECATED**: Use `model` instead                                                                                                                                                               | No       | -                      |
| `fallback_model`                 | Automatic fallback model when default model is overloaded                                                                                                                                         | No       | -                      |
| `max_turns`                      | Maximum number of conversation turns                                                                                                                                                              | No       | -                      |
| `timeout_minutes`                | Timeout in minutes for execution                                                                                                                                                                  | No       | `30`                   |
| `allowed_tools`                  | Additional tools for Claude to use (base Gitea tools are always included)                                                                                                                         | No       | `""`                   |
| `disallowed_tools`               | Tools that Claude should never use                                                                                                                                                                | No       | `""`                   |
| `custom_instructions`            | Additional custom instructions to include in the prompt                                                                                                                                           | No       | `""`                   |
| `prompt`                         | Explicit prompt for Claude. Forwarded to the action as `$PROMPT`                                                                                                                                  | No       | `""`                   |
| `direct_prompt`                  | Direct instruction for Claude (bypasses normal trigger detection)                                                                                                                                 | No       | `""`                   |
| `override_prompt`                | Complete replacement of Claude's prompt with custom template (supports variable substitution)                                                                                                     | No       | `""`                   |
| `settings`                       | Path to Claude Code settings JSON file, or inline settings JSON string                                                                                                                            | No       | `""`                   |
| `system_prompt`                  | Override system prompt                                                                                                                                                                            | No       | `""`                   |
| `append_system_prompt`           | Append to system prompt                                                                                                                                                                           | No       | `""`                   |
| `claude_env`                     | Custom environment variables for Claude Code execution (YAML multiline format)                                                                                                                    | No       | `""`                   |
| `additional_permissions`         | Additional permissions to enable (currently supports `actions: read`)                                                                                                                             | No       | `""`                   |
| `plugins`                        | Newline-separated list of Claude Code plugin names to install (e.g. `code-review@claude-code-plugins`)                                                                                            | No       | `""`                   |
| `plugin_marketplaces`            | Newline-separated list of Claude Code plugin marketplace Git URLs to install from                                                                                                                 | No       | `""`                   |
| `display_report`                 | Render Claude's execution turns as a Step Summary at end of run. Set `false` to suppress                                                                                                          | No       | `true`                 |
| `show_full_output`               | Show full JSON output from Claude Code. **⚠️ Outputs ALL messages including tool results which may contain secrets.** Debug use only                                                              | No       | `false`                |
| `path_to_claude_code_executable` | Path to a custom Claude Code executable instead of installing                                                                                                                                     | No       | `""`                   |
| `path_to_bun_executable`         | Path to a custom Bun executable. Skips automatic Bun install                                                                                                                                      | No       | `""`                   |
| **PR Review Behavior**           |                                                                                                                                                                                                   |          |                        |
| `include_fix_links`              | Include "Fix this →" links in inline PR review feedback that open Claude Code pre-loaded with context to fix the issue                                                                            | No       | `true`                 |
| **Comment Filtering**            |                                                                                                                                                                                                   |          |                        |
| `include_comments_by_actor`      | Comma-separated actor usernames to include in comments. Supports wildcards (e.g. `*[bot]`). Empty includes all                                                                                    | No       | `""`                   |
| `exclude_comments_by_actor`      | Comma-separated actor usernames to exclude from comments. Supports wildcards. Exclusion takes priority over inclusion                                                                             | No       | `""`                   |
| **Access Control**               |                                                                                                                                                                                                   |          |                        |
| `allowed_non_write_users`        | Comma-separated usernames (or `*`) allowed to trigger without write permission. **⚠️ Bypasses security checks; use only for narrowly scoped workflows** (e.g. issue labeling)                     | No       | `""`                   |
| `allowed_bots`                   | Comma-separated bot usernames (or `*`) allowed to trigger. Empty rejects all bots. Only consulted when falling back to github.com path — Gitea doesn't expose a bot type via its User API         | No       | `""`                   |
| **Cloud Providers**              |                                                                                                                                                                                                   |          |                        |
| `use_bedrock`                    | Use Amazon Bedrock with OIDC authentication instead of direct Anthropic API                                                                                                                       | No       | `false`                |
| `use_vertex`                     | Use Google Vertex AI with OIDC authentication instead of direct Anthropic API                                                                                                                     | No       | `false`                |
| `use_node_cache`                 | Use Node.js dependency caching (only for Node.js projects with lock files)                                                                                                                        | No       | `false`                |
| **Git Identity**                 |                                                                                                                                                                                                   |          |                        |
| `claude_git_name`                | Git user.name for commits made by Claude                                                                                                                                                          | No       | `Claude`               |
| `claude_git_email`               | Git user.email for commits made by Claude                                                                                                                                                         | No       | `claude@anthropic.com` |
| `bot_id`                         | Numeric Gitea user ID Claude should impersonate for commits. Produces the noreply email `{id}+{login}@users.noreply.{host}`. Used together with `bot_name`; overrides the `claude_git_*` fallback | No       | `""`                   |
| `bot_name`                       | Gitea username/login Claude should impersonate for commits (companion to `bot_id`)                                                                                                                | No       | `""`                   |
| `ssh_signing_key`                | SSH private key for signing commits. When provided, git is configured to use SSH signing                                                                                                          | No       | `""`                   |

\*Required when using direct Anthropic API (default and when not using Bedrock or Vertex)

## Outputs

| Output              | Description                                                                     |
| ------------------- | ------------------------------------------------------------------------------- |
| `execution_file`    | Path to the Claude Code execution output file                                   |
| `branch_name`       | The branch created by Claude Code for this execution                            |
| `conclusion`        | Execution status: `success` or `failure`                                        |
| `session_id`        | Claude Code session ID (pass to `--resume` to continue the conversation)        |
| `structured_output` | JSON string containing all structured output fields when `--json-schema` is set |

## Gitea Configuration

This action has been enhanced to work with Gitea installations. The main differences from GitHub are:

1. **Local Git Operations**: Instead of using API-based file operations (which have limited support in Gitea), this action uses local git commands to create branches, commit files, and push changes.

2. **Auto-Detection**: The action automatically detects Gitea environments and derives the API URL from the `GITHUB_SERVER_URL` environment variable (set by Gitea Actions).

3. **Custom Server URL**: For Gitea instances running in containers, you can override link generation using the `GITEA_SERVER_URL` environment variable.

### Custom Server URL Configuration

When running Gitea in containers, the action may generate links using internal container URLs (e.g., `http://gitea:3000`) instead of your public URL. To fix this, set the `GITEA_SERVER_URL` environment variable:

```yaml
- uses: nllptrx/claude-code-action@gitea
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    gitea_token: ${{ secrets.GITEA_TOKEN }}
  env:
    # Override the internal container URL with your public URL
    GITEA_SERVER_URL: https://gitea.example.com
```

**How it works:**

- The action first checks for `GITEA_SERVER_URL` (user-configurable)
- Falls back to `GITHUB_SERVER_URL` (automatically set by Gitea Actions)
- Defaults to `https://github.com` only as a last-resort safeguard (should never be hit on a properly configured Gitea runner)

This ensures that all links in Claude's comments (job runs, branches, etc.) point to your public Gitea instance instead of internal container addresses.

See [`examples/gitea-custom-url.yml`](./examples/gitea-custom-url.yml) for a complete example.

### Gitea Setup Notes

- Use a Gitea personal access token "GITEA_TOKEN"
- The token needs repository read/write permissions
- Claude will use local git operations for file changes and branch creation
- Only PR creation and comment updates use the Gitea API

## Examples

### Ways to Tag @claude

These examples show how to interact with Claude using comments in PRs and issues. By default, Claude will be triggered anytime you mention `@claude`, but you can customize the exact trigger phrase using the `trigger_phrase` input in the workflow.

Claude will see the full PR context, including any comments.

#### Ask Questions

Add a comment to a PR or issue:

```
@claude What does this function do and how could we improve it?
```

Claude will analyze the code and provide a detailed explanation with suggestions.

#### Request Fixes

Ask Claude to implement specific changes:

```
@claude Can you add error handling to this function?
```

#### Code Review

Get a thorough review:

```
@claude Please review this PR and suggest improvements
```

Claude will analyze the changes and provide feedback.

#### Fix Bugs from Screenshots

Upload a screenshot of a bug and ask Claude to fix it:

```
@claude Here's a screenshot of a bug I'm seeing [upload screenshot]. Can you fix it?
```

Claude can see and analyze images, making it easy to fix visual bugs or UI issues.

### Custom Automations

These examples show how to configure Claude to act automatically based on Gitea events, without requiring manual @mentions.

#### Supported Gitea Events

This action supports the following Gitea events:

- `pull_request` - When PRs are opened or synchronized
- `issue_comment` - When comments are created on issues or PRs
- `pull_request_comment` - When comments are made on PR diffs
- `issues` - When issues are opened or assigned
- `pull_request_review` - When PR reviews are submitted
- `pull_request_review_comment` - When comments are made on PR reviews
- `workflow_dispatch` - Manual workflow triggers
- `repository_dispatch` - Custom events triggered via API (not yet supported)

#### Automated Documentation Updates

Automatically update documentation when specific files change (see [`examples/claude-pr-path-specific.yml`](./examples/claude-pr-path-specific.yml)):

```yaml
on:
  pull_request:
    paths:
      - "src/api/**/*.ts"

steps:
  - uses: nllptrx/claude-code-action@gitea
    with:
      direct_prompt: |
        Update the API documentation in README.md to reflect
        the changes made to the API endpoints in this PR.
```

When API files are modified, Claude automatically updates your README with the latest endpoint documentation and pushes the changes back to the PR, keeping your docs in sync with your code.

#### Author-Specific Code Reviews

Automatically review PRs from specific authors or external contributors (see [`examples/claude-review-from-author.yml`](./examples/claude-review-from-author.yml)):

```yaml
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review-by-author:
    if: |
      github.event.pull_request.user.login == 'developer1' ||
      github.event.pull_request.user.login == 'external-contributor'
    steps:
      - uses: nllptrx/claude-code-action@gitea
        with:
          direct_prompt: |
            Please provide a thorough review of this pull request.
            Pay extra attention to coding standards, security practices,
            and test coverage since this is from an external contributor.
```

Perfect for automatically reviewing PRs from new team members, external contributors, or specific developers who need extra guidance.

#### Custom Prompt Templates

Use `override_prompt` for complete control over Claude's behavior with variable substitution:

```yaml
- uses: nllptrx/claude-code-action@gitea
  with:
    override_prompt: |
      Analyze PR #$PR_NUMBER in $REPOSITORY for security vulnerabilities.

      Changed files:
      $CHANGED_FILES

      Focus on:
      - SQL injection risks
      - XSS vulnerabilities
      - Authentication bypasses
      - Exposed secrets or credentials

      Provide severity ratings (Critical/High/Medium/Low) for any issues found.
```

The `override_prompt` feature supports these variables:

- `$REPOSITORY`, `$PR_NUMBER`, `$ISSUE_NUMBER`
- `$PR_TITLE`, `$ISSUE_TITLE`, `$PR_BODY`, `$ISSUE_BODY`
- `$PR_COMMENTS`, `$ISSUE_COMMENTS`, `$REVIEW_COMMENTS`
- `$CHANGED_FILES`, `$TRIGGER_COMMENT`, `$TRIGGER_USERNAME`
- `$BRANCH_NAME`, `$BASE_BRANCH`, `$EVENT_TYPE`, `$IS_PR`

## How It Works

1. **Trigger Detection**: Listens for comments containing the trigger phrase (default: `@claude`), issue/PR assignment, or configured labels
2. **Tracking Comment**: Creates (or reuses an existing) checkbox-style tracking comment so a single thread per issue/PR stays coherent
3. **Context Gathering**: Analyzes the PR/issue, comments, code changes, and optionally CI run results
4. **Execution**: Runs through the unified `src/entrypoints/run.ts` entrypoint; optionally installs Claude Code plugins, then invokes the Claude Code SDK
5. **Smart Responses**: Either answers questions, edits files via local git ops, or files inline PR review comments
6. **Branch Management**: Issues → new branch; open PRs → push to existing branch; closed PRs → new branch
7. **Communication**: Streams progress into the tracking comment; renders a full execution-turn report to the Step Summary

This action is built specifically for Gitea environments with local git operations support.

## Capabilities and Limitations

### What Claude Can Do

- **Respond in a Single Comment**: Claude operates by updating a single initial comment with progress and results
- **Answer Questions**: Analyze code and provide explanations
- **Implement Code Changes**: Make simple to moderate code changes based on requests
- **Prepare Pull Requests**: Creates commits on a branch and links back to a prefilled PR creation page
- **Perform Code Reviews**: Analyze PR changes and provide detailed feedback
- **Smart Branch Handling**:
  - When triggered on an **issue**: Always creates a new branch for the work
  - When triggered on an **open PR**: Always pushes directly to the existing PR branch
  - When triggered on a **closed PR**: Creates a new branch since the original is no longer active
- **View CI Results**: Can access workflow runs, job logs, and test results on the PR where it's tagged when `actions: read` permission is configured (see [Additional Permissions for CI/CD Integration](#additional-permissions-for-cicd-integration)). Works on both Gitea Actions and GitHub Actions
- **File Inline PR Review Comments**: Posts Copilot-style inline feedback on specific lines via `mcp__gitea__create_pull_request_review`, optionally with "Fix this →" links

### What Claude Cannot Do

- **Approve PRs**: For security reasons, Claude cannot approve pull requests (reviews are limited to `COMMENT` and `REQUEST_CHANGES` via `mcp__gitea__create_pull_request_review`)
- **Post Multiple Comments**: Claude only acts by updating its initial comment
- **Execute Commands Outside Its Context**: Claude only has access to the repository and PR/issue context it's triggered in
- **Run Arbitrary Bash Commands**: By default, Claude cannot execute Bash commands unless explicitly allowed using the `allowed_tools` configuration
- **Perform Branch Operations**: Cannot merge branches, rebase, or perform other git operations beyond pushing commits

## Advanced Configuration

### Additional Permissions for CI/CD Integration

The `additional_permissions` input allows Claude to access workflow/CI run information when you grant the necessary permissions. This is particularly useful for analyzing CI failures and debugging workflow issues. Works on both Gitea Actions and GitHub Actions — the underlying API surface is compatible.

#### Enabling CI/CD Access

To allow Claude to view workflow run results, job logs, and CI status:

1. **Grant the necessary permission to your token**:

   - Add the `actions: read` permission to your workflow:

   ```yaml
   permissions:
     contents: write
     pull-requests: write
     issues: write
     actions: read # Add this line
   ```

   **Gitea note**: Gitea does not expose a literal `actions: read` token scope the way GitHub does. On Gitea it's sufficient that the token has **repo read access** and that the **Actions unit is enabled** on the repository — the action probes the Actions API at startup to verify permission, logs a warning if the probe fails, and skips MCP server registration rather than failing the run. The `additional_permissions: actions: read` input is still required so that the tools get added to Claude's allowlist.

2. **Configure the action with additional permissions**:

   ```yaml
   - uses: nllptrx/claude-code-action@gitea
     with:
       anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
       additional_permissions: |
         actions: read
       # ... other inputs
   ```

3. **Claude will automatically get access to CI/CD tools**:
   When you enable `actions: read`, Claude can use the following MCP tools:
   - `mcp__github_actions__get_ci_status` - View workflow run statuses
   - `mcp__github_actions__get_workflow_run_details` - Get detailed workflow information
   - `mcp__github_actions__download_job_log` - Download and analyze job logs

#### Example: Debugging Failed CI Runs

```yaml
name: Claude CI Helper
on:
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write
  actions: read # Required for CI access

jobs:
  claude-ci-helper:
    runs-on: ubuntu-latest
    steps:
      - uses: nllptrx/claude-code-action@gitea
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          additional_permissions: |
            actions: read
          # Now Claude can respond to "@claude why did the CI fail?"
```

**Important Notes**:

- The workflow token must have the `actions: read` permission
- If the permission is missing, Claude will warn you and suggest adding it
- Currently, only `actions: read` is supported, but the format allows for future extensions

### Custom Environment Variables

You can pass custom environment variables to Claude Code execution using the `claude_env` input. This is useful for CI/test setups that require specific environment variables:

```yaml
- uses: nllptrx/claude-code-action@gitea
  with:
    claude_env: |
      NODE_ENV: test
      CI: true
      DATABASE_URL: postgres://test:test@localhost:5432/test_db
    # ... other inputs
```

The `claude_env` input accepts YAML format where each line defines a key-value pair. These environment variables will be available to Claude Code during execution, allowing it to run tests, build processes, or other commands that depend on specific environment configurations.

### Limiting Conversation Turns

You can use the `max_turns` parameter to limit the number of back-and-forth exchanges Claude can have during task execution. This is useful for:

- Controlling costs by preventing runaway conversations
- Setting time boundaries for automated workflows
- Ensuring predictable behavior in CI/CD pipelines

```yaml
- uses: nllptrx/claude-code-action@gitea
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    max_turns: "5" # Limit to 5 conversation turns
    # ... other inputs
```

When the turn limit is reached, Claude will stop execution gracefully. Choose a value that gives Claude enough turns to complete typical tasks while preventing excessive usage.

### Custom Tools

By default, Claude only has access to:

- File operations (reading, committing, editing files, read-only git commands)
- Comment management (creating/updating comments)
- Basic Gitea operations

Claude does **not** have access to execute arbitrary Bash commands by default. If you want Claude to run specific commands (e.g., npm install, npm test), you must explicitly allow them using the `allowed_tools` configuration:

**Note**: If your repository has a `.mcp.json` file in the root directory, Claude will automatically detect and use the MCP server tools defined there. However, these tools still need to be explicitly allowed via the `allowed_tools` configuration.

```yaml
- uses: nllptrx/claude-code-action@gitea
  with:
    allowed_tools: |
      Bash(npm install)
      Bash(npm run test)
      Edit
      Replace
      NotebookEditCell
    disallowed_tools: |
      TaskOutput
      KillTask
    # ... other inputs
```

**Note**: The base Gitea tools are always included. Use `allowed_tools` to add additional tools (including specific Bash commands), and `disallowed_tools` to prevent specific tools from being used.

### Custom Model

Use a specific Claude model:

```yaml
- uses: nllptrx/claude-code-action@gitea
  with:
    model: "claude-sonnet-4-6" # or "claude-opus-4-7"; Bedrock/Vertex use provider-prefixed IDs
    # ... other inputs
```

### Claude Code Settings

You can provide Claude Code settings to customize behavior such as model selection, environment variables, permissions, and hooks. Settings can be provided either as a JSON string or a path to a settings file.

#### Option 1: Settings File

```yaml
- uses: nllptrx/claude-code-action@gitea
  with:
    settings: "path/to/settings.json"
    # ... other inputs
```

#### Option 2: Inline Settings

```yaml
- uses: nllptrx/claude-code-action@gitea
  with:
    settings: |
      {
        "model": "claude-opus-4-20250514",
        "env": {
          "DEBUG": "true",
          "API_URL": "https://api.example.com"
        },
        "permissions": {
          "allow": ["Bash", "Read"],
          "deny": ["WebFetch"]
        },
        "hooks": {
          "PreToolUse": [{
            "matcher": "Bash",
            "hooks": [{
              "type": "command",
              "command": "echo Running bash command..."
            }]
          }]
        }
      }
    # ... other inputs
```

The settings support all Claude Code settings options including:

- `model`: Override the default model
- `env`: Environment variables for the session
- `permissions`: Tool usage permissions
- `hooks`: Pre/post tool execution hooks
- And more...

For a complete list of available settings and their descriptions, see the [Claude Code settings documentation](https://docs.anthropic.com/en/docs/claude-code/settings).

**Notes**:

- The `enableAllProjectMcpServers` setting is always set to `true` by this action to ensure MCP servers work correctly.
- If both the `model` input parameter and a `model` in settings are provided, the `model` input parameter takes precedence.
- The `allowed_tools` and `disallowed_tools` input parameters take precedence over `permissions` in settings.
- In a future version, we may deprecate individual input parameters in favor of using the settings file for all configuration.

## Cloud Providers

You can authenticate with Claude using any of these methods:

1. **Direct Anthropic API** (default) - Use your Anthropic API key
2. **Claude Code OAuth Token** - Use OAuth token from Claude Code application

### Using Claude Code OAuth Token

If you have access to [Claude Code](https://claude.ai/code), you can use OAuth authentication instead of an API key:

1. **Generate OAuth Token**: run the following command and follow instructions:

   ```
   claude setup-token
   ```

   This will generate an OAuth token that you can use for authentication.

2. **Add Token to Repository**: Add the generated token as a repository secret named `CLAUDE_CODE_OAUTH_TOKEN`.

3. **Configure Workflow**: Use the OAuth token in your workflow:

```yaml
- uses: nllptrx/claude-code-action@gitea
  with:
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    gitea_token: ${{ secrets.GITEA_TOKEN }}
```

When `claude_code_oauth_token` is provided, it will be used instead of `anthropic_api_key` for authentication.

## Security

### Access Control

- **Repository Access**: The action can only be triggered by users with write access to the repository
- **No Bot Triggers**: Bots cannot trigger this action
- **Token Permissions**: The Gitea token is scoped specifically to the repository it's operating in
- **No Cross-Repository Access**: Each action invocation is limited to the repository where it was triggered
- **Limited Scope**: The token cannot access other repositories or perform actions beyond the configured permissions

### Gitea Token Permissions

The Gitea personal access token requires these permissions:

- **Pull Requests**: Read and write to create PRs and push changes
- **Issues**: Read and write to respond to issues
- **Contents**: Read and write to modify repository files

### Authentication Security

**⚠️ IMPORTANT: Never commit API keys directly to your repository! Always use Gitea Actions secrets.**

To securely use your Anthropic API key:

1. Add your API key as a repository secret:

   - Go to your repository's Settings
   - Navigate to "Secrets and variables" → "Actions"
   - Click "New repository secret"
   - Name it `ANTHROPIC_API_KEY`
   - Paste your API key as the value

2. Reference the secret in your workflow:
   ```yaml
   anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

**Never do this:**

```yaml
# ❌ WRONG - Exposes your API key
anthropic_api_key: "sk-ant-..."
```

**Always do this:**

```yaml
# ✅ CORRECT - Uses Gitea secrets
anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

This applies to all sensitive values including API keys, access tokens, and credentials.

## Available Workflow Types

The plugin (`/gitea-ci`) and the [`examples/`](./examples/) directory both offer these workflow types:

| Type                 | Example File                   | Description                                          |
| -------------------- | ------------------------------ | ---------------------------------------------------- |
| `assistant`          | `gitea-claude.yml`             | Interactive @claude trigger for issues and PRs       |
| `auto-review`        | `claude-auto-review.yml`       | Automatic PR review on open/sync                     |
| `path-review`        | `pr-review-filtered-paths.yml` | PR review filtered by file paths                     |
| `issue-auto-comment` | —                              | Auto-analyze newly opened/edited issues              |
| `issue-triage`       | `issue-triage.yml`             | Auto-label, categorize, and detect duplicate issues  |
| `ci-fix`             | `ci-failure-auto-fix.yml`      | Analyze CI failures (analysis-only or auto-fix mode) |

Use `/gitea-ci <type>` to generate a configured version, or copy from `examples/` directly.

## License

This project is licensed under the MIT License—see the LICENSE file for details.
