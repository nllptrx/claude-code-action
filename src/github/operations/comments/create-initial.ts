#!/usr/bin/env bun

/**
 * Create (or reset) the tracking comment when Claude Code starts working.
 *
 * On first run for an entity we POST a fresh comment. On subsequent runs
 * we locate the prior Claude tracking comment and PATCH its body back to
 * the "Claude Code is working…" placeholder, so Claude never sees the
 * previous run's bug list / stale job link as reference material in
 * `fetchGitHubData`. Fixes the duplicate-findings + stale-run-link
 * issue that surfaced during PR review E2E validation (PR #5 run #13).
 */

import { appendFileSync } from "fs";
import { createJobRunLink, createCommentBody } from "./common";
import {
  isPullRequestReviewCommentEvent,
  type ParsedGitHubContext,
} from "../../context";
import type { GiteaApiClient } from "../../api/gitea-client";

// HACK: Gitea's list/preview view does not render inline HTML and shows raw <img> tags as text.
// To work around this, we create the comment with a plain-text placeholder first, then
// immediately edit it to the actual working status body (which renders correctly in full view).
// The preview caches the initial text, so it stays clean in the list.
// Remove this once Gitea supports HTML rendering in comment previews.
const PREVIEW_PLACEHOLDER = "Claude Code response preview is available";

/**
 * Match a Claude-authored tracking comment by looking for the stable
 * header strings we emit. Covers the "working" and "finished" / "error"
 * states so a run triggered while a prior one is still in-flight (rare)
 * or after completion both reuse the same id.
 */
function isClaudeTrackingComment(body: string | undefined | null): boolean {
  if (!body) return false;
  return (
    body.includes("Claude Code is working") ||
    /\*\*Claude (finished|encountered an error)/.test(body)
  );
}

export async function createInitialComment(
  api: GiteaApiClient,
  context: ParsedGitHubContext,
) {
  const { owner, repo } = context.repository;

  const jobRunLink = createJobRunLink(owner, repo, context.runId);
  const workingBody = createCommentBody(jobRunLink);

  try {
    let commentId: number | undefined;

    console.log(
      `Creating/resetting tracking comment for ${context.isPR ? "PR" : "issue"} #${context.entityNumber}`,
    );
    console.log(`Repository: ${owner}/${repo}`);

    // PR review comments are their own thread (replies to a specific
    // code-line comment); no reuse — always post a fresh placeholder.
    if (isPullRequestReviewCommentEvent(context)) {
      console.log(`Creating PR review comment reply`);
      const response = await api.customRequest(
        "POST",
        `/repos/${owner}/${repo}/pulls/${context.entityNumber}/comments/${context.payload.comment.id}/replies`,
        { body: PREVIEW_PLACEHOLDER },
      );
      commentId = response.data.id;
    } else {
      // Issue / issue_comment / PR events: look for the most recent
      // Claude-authored tracking comment and reset its body instead of
      // spawning a new one. Without this, Claude on a re-trigger would
      // see the prior run's full review body in the comments list and
      // carry its content (including stale run links) into the new run.
      const existing = await api
        .listIssueComments(owner, repo, context.entityNumber)
        .catch((err) => {
          console.warn(
            `Could not list prior comments (will POST a fresh one): ${err}`,
          );
          return { data: [] as Array<{ id: number; body?: string }> };
        });

      const prior = [...(existing.data || [])]
        .reverse()
        .find((c) => isClaudeTrackingComment(c.body));

      if (prior && prior.id) {
        console.log(
          `Reusing prior Claude tracking comment ${prior.id} (resetting to working state)`,
        );
        commentId = prior.id;
      } else {
        console.log(`No prior tracking comment found; creating a new one`);
        const response = await api.createIssueComment(
          owner,
          repo,
          context.entityNumber,
          PREVIEW_PLACEHOLDER,
        );
        commentId = response.data.id;
      }
    }

    if (commentId === undefined) {
      throw new Error("Failed to obtain tracking comment id");
    }

    // PATCH the body to the fresh working state. Unlike GitHub, Gitea's
    // REST API stores PR review comments and issue comments in the same
    // table (issues_model.Comment with CommentTypeCode discriminator) and
    // exposes only ONE edit endpoint — PATCH /repos/{o}/{r}/issues/comments/{id} —
    // which works for both kinds. The parallel /pulls/comments/{id} PATCH
    // does NOT exist in Gitea (only /resolve and /unresolve POST routes
    // live there). So a single updateIssueComment call is correct.
    // Verified: https://deepwiki.com/go-gitea/gitea search "pulls/comments PATCH".
    await api.updateIssueComment(owner, repo, commentId, workingBody);

    // Output the comment ID for downstream steps using GITHUB_OUTPUT
    const githubOutput = process.env.GITHUB_OUTPUT!;
    appendFileSync(githubOutput, `claude_comment_id=${commentId}\n`);
    console.log(`✅ Created initial comment with ID: ${commentId}`);
    return commentId;
  } catch (error) {
    console.error("Error in initial comment:", error);

    // Always fall back to regular issue comment if anything fails
    try {
      const response = await api.createIssueComment(
        owner,
        repo,
        context.entityNumber,
        PREVIEW_PLACEHOLDER,
      );

      const commentId = response.data.id;
      await api
        .updateIssueComment(owner, repo, commentId, workingBody)
        .catch(() => {});

      const githubOutput = process.env.GITHUB_OUTPUT!;
      appendFileSync(githubOutput, `claude_comment_id=${commentId}\n`);
      console.log(`✅ Created fallback comment with ID: ${commentId}`);
      return commentId;
    } catch (fallbackError) {
      console.error("Error creating fallback comment:", fallbackError);
      throw fallbackError;
    }
  }
}
