import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import {
  configureGitAuth,
  setupSshSigning,
} from "../../github/operations/git-config";
import { checkHumanActor } from "../../github/validation/actor";
import { createAgentPrompt, configureTools } from "../../create-prompt";
import type { GitHubContext } from "../../github/context";
import type { GitHubClient } from "../../github/api/client";

/**
 * Prepares the agent mode execution context.
 *
 * Agent mode runs whenever an explicit prompt is provided in the workflow
 * configuration. It bypasses the @claude mention checking and tracking-comment
 * flow used by tag mode, providing direct Claude Code execution for automation
 * workflows.
 */
export async function prepareAgentMode({
  context,
  client,
  githubToken,
}: {
  context: GitHubContext;
  client: GitHubClient;
  githubToken: string;
}) {
  await checkHumanActor(client.api, context);

  // SSH signing takes precedence when set. API commit signing is upstream-
  // only (relies on GitHub file_ops MCP); on Gitea we fall through to plain
  // git CLI auth in that branch too.
  if (context.inputs.sshSigningKey) {
    await setupSshSigning(context.inputs.sshSigningKey);
  }

  try {
    await configureGitAuth(githubToken, context, null);
  } catch (error) {
    console.error("Failed to configure git authentication:", error);
    // Continue anyway — git operations may still work with default config
  }

  await createAgentPrompt(undefined, context);
  configureTools(context);

  const claudeBranch = process.env.CLAUDE_BRANCH || undefined;
  const defaultBranch = context.repository.default_branch || "main";
  const baseBranch = context.inputs.baseBranch || defaultBranch;
  const currentBranch =
    claudeBranch ||
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    defaultBranch;

  const mcpConfig = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: currentBranch,
    baseBranch,
    allowedTools: context.inputs.allowedTools,
    context,
  });

  return {
    commentId: undefined as number | undefined,
    branchInfo: {
      baseBranch,
      currentBranch: baseBranch,
      claudeBranch,
    },
    mcpConfig,
  };
}
