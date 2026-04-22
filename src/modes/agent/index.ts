import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import {
  configureGitAuth,
  setupSshSigning,
} from "../../github/operations/git-config";
import { checkHumanActor } from "../../github/validation/actor";
import { createAgentPrompt, configureTools } from "../../create-prompt";
import { fetchGitHubData } from "../../github/data/fetcher";
import { isEntityContext } from "../../github/context";
import { setupBranch } from "../../github/operations/branch";
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

  // Compat: the published `prompt` input is an alternate spelling of
  // `direct_prompt`. Promote it before createAgentPrompt so workflows that
  // set only `prompt:` keep working.
  if (
    !context.inputs.directPrompt &&
    !context.inputs.overridePrompt &&
    context.inputs.prompt
  ) {
    context.inputs.directPrompt = context.inputs.prompt;
  }

  // Resolve baseBranch for entity-event prompt substitution. prepareContext
  // (called inside createAgentPrompt's override_prompt path) requires a
  // base branch for issue / issue_comment events. Tag mode resolves this
  // via setupBranch; agent mode doesn't branch, so default to the repo's
  // default_branch when the user didn't supply one.
  if (!context.inputs.baseBranch) {
    context.inputs.baseBranch =
      context.repository.default_branch ||
      process.env.GITHUB_REF_NAME ||
      "main";
  }

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

  // Entity-triggered agent runs (issue/PR events with `mode: agent`) still
  // need setupBranch: it ensures a claude-branch exists and the checkout
  // points at it, so Claude's local git tools commit/push to the right
  // place. Fetch data first (also used for override_prompt variable
  // substitution); automation events skip both.
  let githubData:
    | Awaited<ReturnType<typeof fetchGitHubData>>
    | undefined;
  let baseBranch: string;
  let currentBranch: string;
  let claudeBranch: string | undefined;

  if (isEntityContext(context)) {
    githubData = await fetchGitHubData({
      client,
      repository: `${context.repository.owner}/${context.repository.repo}`,
      prNumber: context.entityNumber.toString(),
      isPR: context.isPR,
      includeCommentsByActor: context.inputs.includeCommentsByActor || "",
      excludeCommentsByActor: context.inputs.excludeCommentsByActor || "",
    });

    const branchInfo = await setupBranch(client, githubData, context);
    baseBranch = branchInfo.baseBranch;
    currentBranch = branchInfo.currentBranch;
    claudeBranch = branchInfo.claudeBranch;
    // createAgentPrompt → prepareContext reads context.inputs.baseBranch for
    // $BASE_BRANCH substitution. Overwrite the provisional default (or
    // user-supplied value) with the branch setupBranch actually resolved,
    // which is the real target for PR events (not always default_branch).
    context.inputs.baseBranch = baseBranch;
  } else {
    // Automation events (workflow_dispatch, schedule, workflow_run).
    const defaultBranch = context.repository.default_branch || "main";
    baseBranch = context.inputs.baseBranch || defaultBranch;
    claudeBranch = process.env.CLAUDE_BRANCH || undefined;
    currentBranch =
      claudeBranch ||
      process.env.GITHUB_HEAD_REF ||
      process.env.GITHUB_REF_NAME ||
      defaultBranch;
  }

  await createAgentPrompt(githubData, context);
  configureTools(context);

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
