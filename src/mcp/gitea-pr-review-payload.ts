// Pure helpers for the gitea_mcp_server's create_pull_request_review tool.
// Kept in a separate module so the MCP server's startup side effects
// (stdio transport connect, env-var process.exit) don't run during unit tests.

import { z } from "zod";
import { sanitizeContent } from "../github/utils/sanitizer";

/**
 * Zod schema for the create_pull_request_review tool input.
 *
 * event is intentionally restricted to "COMMENT" or "REQUEST_CHANGES".
 * APPROVED is NOT allowed — Claude must not auto-approve PRs, matching the
 * guardrail upstream declares in src/mcp/github-inline-comment-server.ts
 * ("Claude can't accidentally approve a PR").
 */
export const createPrReviewInputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  index: z.number().int().positive(),
  body: z.string().optional(),
  event: z.enum(["COMMENT", "REQUEST_CHANGES"]),
  commit_id: z.string().optional(),
  comments: z
    .array(
      z.object({
        body: z.string(),
        path: z.string(),
        new_position: z.number().int().optional(),
        old_position: z.number().int().optional(),
      }),
    )
    .optional(),
});

export type CreatePrReviewInput = z.infer<typeof createPrReviewInputSchema>;

/**
 * Build the Gitea API payload for
 *   POST /repos/{owner}/{repo}/pulls/{index}/reviews
 *
 * Sanitizes all user-supplied bodies (review body + each inline comment body)
 * via sanitizeContent to strip control characters and other unsafe markers
 * before the payload hits the Gitea API.
 *
 * Omits optional fields cleanly — bare-COMMENT reviews get just { event }.
 */
export function buildPrReviewPayload(
  input: Pick<CreatePrReviewInput, "body" | "event" | "commit_id" | "comments">,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { event: input.event };

  if (input.body !== undefined) {
    payload.body = sanitizeContent(input.body);
  }
  if (input.commit_id !== undefined) {
    payload.commit_id = input.commit_id;
  }
  if (input.comments && input.comments.length > 0) {
    payload.comments = input.comments.map((c) => ({
      body: sanitizeContent(c.body),
      path: c.path,
      ...(c.new_position !== undefined && { new_position: c.new_position }),
      ...(c.old_position !== undefined && { old_position: c.old_position }),
    }));
  }

  return payload;
}
