import { checkHumanActor } from "../../github/validation/actor";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { updateTrackingComment } from "../../github/operations/comments/update-with-branch";
import { setupBranch } from "../../github/operations/branch";
import {
  configureGitAuth,
  setupSshSigning,
} from "../../github/operations/git-config";
import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import { fetchGitHubData } from "../../github/data/fetcher";
import { createPrompt } from "../../create-prompt";
import { isEntityContext } from "../../github/context";
import type { GitHubContext } from "../../github/context";
import type { GitHubClient } from "../../github/api/client";

/**
 * Prepares the tag mode execution context.
 *
 * Tag mode responds to @claude mentions, issue assignments, or labels.
 * Creates a tracking comment, fetches repo context, sets up a branch, and
 * writes the prompt file. Returns the data run.ts needs to invoke Claude.
 */
export async function prepareTagMode({
  context,
  client,
  githubToken,
}: {
  context: GitHubContext;
  client: GitHubClient;
  githubToken: string;
}) {
  if (!isEntityContext(context)) {
    throw new Error("Tag mode requires entity context");
  }

  await checkHumanActor(client.api, context);

  const commentId = await createInitialComment(client.api, context);

  const githubData = await fetchGitHubData({
    client,
    repository: `${context.repository.owner}/${context.repository.repo}`,
    prNumber: context.entityNumber.toString(),
    isPR: context.isPR,
    includeCommentsByActor: context.inputs.includeCommentsByActor || "",
    excludeCommentsByActor: context.inputs.excludeCommentsByActor || "",
  });

  const branchInfo = await setupBranch(client, githubData, context);

  if (branchInfo.claudeBranch) {
    await updateTrackingComment(
      client,
      context,
      commentId,
      branchInfo.claudeBranch,
    );
  }

  // Git auth — SSH signing takes precedence if provided.
  // API commit signing is upstream-only on Gitea; fall through to plain git
  // CLI auth in that branch too.
  const useSshSigning = !!context.inputs.sshSigningKey;
  if (useSshSigning) {
    await setupSshSigning(context.inputs.sshSigningKey!);
  }

  try {
    await configureGitAuth(githubToken, context, null);
  } catch (error) {
    console.error("Failed to configure git authentication:", error);
    throw error;
  }

  // Build prompt file + export ALLOWED_TOOLS / DISALLOWED_TOOLS env vars.
  await createPrompt(
    commentId,
    branchInfo.baseBranch,
    branchInfo.claudeBranch,
    githubData,
    context,
  );

  const mcpConfig = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: branchInfo.claudeBranch || branchInfo.currentBranch,
    baseBranch: branchInfo.baseBranch,
    allowedTools: context.inputs.allowedTools,
    context,
  });

  return {
    commentId,
    branchInfo,
    mcpConfig,
  };
}
