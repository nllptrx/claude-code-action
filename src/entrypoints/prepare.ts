#!/usr/bin/env bun

/**
 * Prepare the Claude action by checking trigger conditions, verifying human actor,
 * and creating the initial tracking comment
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { checkTriggerAction } from "../github/validation/trigger";
import { checkHumanActor } from "../github/validation/actor";
import { checkWritePermissions } from "../github/validation/permissions";
import { createInitialComment } from "../github/operations/comments/create-initial";
import { setupBranch } from "../github/operations/branch";
import { updateTrackingComment } from "../github/operations/comments/update-with-branch";
import { prepareMcpConfig } from "../mcp/install-mcp-server";
import { createPrompt } from "../create-prompt";
import { createClient } from "../github/api/client";
import { fetchGitHubData } from "../github/data/fetcher";
import { parseGitHubContext, isEntityContext } from "../github/context";
import type { ParsedGitHubContext } from "../github/context";
import { getMode } from "../modes/registry";

async function run() {
  try {
    console.log("=== Claude Action Prepare Starting ===");
    console.log("Event name:", process.env.GITHUB_EVENT_NAME);
    console.log("Repository:", process.env.GITHUB_REPOSITORY);

    // Step 1: Setup GitHub token
    const githubToken = await setupGitHubToken();
    const client = createClient(githubToken);

    // Step 2: Parse GitHub context (once for all operations)
    const context = parseGitHubContext();
    console.log(
      "Parsed context - Event:",
      context.eventName,
      "Actor:",
      context.actor,
    );

    // Step 3: Check write permissions
    const hasWritePermissions = await checkWritePermissions(
      client.api,
      context,
      context.inputs.allowedNonWriteUsers,
      !!process.env.OVERRIDE_GITHUB_TOKEN,
    );
    if (!hasWritePermissions) {
      throw new Error(
        "Actor does not have write permissions to the repository",
      );
    }

    // Step 4: Check trigger conditions
    console.log("Checking trigger with phrase:", context.inputs.triggerPhrase);
    const containsTrigger = await checkTriggerAction(context);
    console.log("Trigger check result:", containsTrigger);

    // Set outputs that are always needed
    core.setOutput("contains_trigger", containsTrigger.toString());
    core.setOutput("GITHUB_TOKEN", githubToken);

    if (!containsTrigger) {
      console.log("❌ No trigger found, skipping remaining steps");
      console.log("Event was:", context.eventName);
      console.log("Mode:", context.inputs.mode);
      return;
    }

    console.log("✅ Trigger detected, proceeding with Claude execution");

    // Step 5: Check if actor is human
    await checkHumanActor(client.api, context);

    const mode = getMode(context.inputs.mode);

    if (isEntityContext(context)) {
      // Entity events (issues, PRs, comments): full flow with data fetch + branch setup
      const entityContext = context as ParsedGitHubContext;

      // Step 6: Create initial tracking comment (if required by mode)
      let commentId: number | undefined;
      if (mode.shouldCreateTrackingComment()) {
        commentId = await createInitialComment(client.api, entityContext);
        core.setOutput("claude_comment_id", commentId!.toString());
      }

      // Step 7: Fetch GitHub data
      const githubData = await fetchGitHubData({
        client: client,
        repository: `${entityContext.repository.owner}/${entityContext.repository.repo}`,
        prNumber: entityContext.entityNumber.toString(),
        isPR: entityContext.isPR,
        includeCommentsByActor:
          entityContext.inputs.includeCommentsByActor || "",
        excludeCommentsByActor:
          entityContext.inputs.excludeCommentsByActor || "",
      });

      // Step 8: Setup branch
      const branchInfo = await setupBranch(client, githubData, entityContext);
      core.setOutput("BASE_BRANCH", branchInfo.baseBranch);
      if (branchInfo.claudeBranch) {
        core.setOutput("CLAUDE_BRANCH", branchInfo.claudeBranch);
      }

      // Step 9: Update initial comment with branch link
      if (commentId && branchInfo.claudeBranch) {
        await updateTrackingComment(
          client,
          entityContext,
          commentId,
          branchInfo.claudeBranch,
        );
      }

      // Step 10: Create prompt file
      const modeContext = mode.prepareContext(entityContext, {
        commentId,
        baseBranch: branchInfo.baseBranch,
        claudeBranch: branchInfo.claudeBranch,
      });

      await createPrompt(mode, modeContext, githubData, entityContext);

      // Step 11: Get MCP configuration
      const mcpConfig = await prepareMcpConfig({
        githubToken,
        owner: entityContext.repository.owner,
        repo: entityContext.repository.repo,
        branch: branchInfo.currentBranch,
        baseBranch: branchInfo.baseBranch,
        allowedTools: entityContext.inputs.allowedTools,
        context: entityContext,
      });
      core.setOutput("mcp_config", mcpConfig);
    } else {
      // Automation events (workflow_run, workflow_dispatch, schedule): headless flow
      console.log(
        `Automation event (${context.eventName}), using headless flow`,
      );

      const baseBranch =
        context.inputs.baseBranch || process.env.GITHUB_REF_NAME || "main";
      core.setOutput("BASE_BRANCH", baseBranch);

      const modeContext = mode.prepareContext(context, {
        baseBranch,
      });

      await createPrompt(mode, modeContext, undefined, context);

      const currentBranch =
        process.env.GITHUB_HEAD_REF ||
        process.env.GITHUB_REF_NAME ||
        baseBranch;

      const mcpConfig = await prepareMcpConfig({
        githubToken,
        owner: context.repository.owner,
        repo: context.repository.repo,
        branch: currentBranch,
        baseBranch,
        allowedTools: context.inputs.allowedTools,
        context,
      });
      core.setOutput("mcp_config", mcpConfig);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Prepare step failed with error: ${errorMessage}`);
    // Also output the clean error message for the action to capture
    core.setOutput("prepare_error", errorMessage);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
