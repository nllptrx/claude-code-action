import { GITEA_SERVER_URL } from "../../api/config";

function getSpinnerHtml(): string {
  return `<img src="https://raw.githubusercontent.com/nllptrx/claude-code-action/refs/heads/gitea/assets/spinner.gif" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />`;
}

export const SPINNER_HTML = getSpinnerHtml();

export function createJobRunLink(
  owner: string,
  repo: string,
  runId: string,
): string {
  const jobRunUrl = `${GITEA_SERVER_URL}/${owner}/${repo}/actions/runs/${runId}`;
  return `[View job run](${jobRunUrl})`;
}

export function createBranchLink(
  owner: string,
  repo: string,
  branchName: string,
): string {
  const branchUrl = `${GITEA_SERVER_URL}/${owner}/${repo}/src/branch/${branchName}/`;
  return `\n[View branch](${branchUrl})`;
}

/**
 * Exact placeholder prose written into the initial tracking comment.
 * Exported so updateCommentBody can strip it when rewriting — without
 * this the terminal comment keeps showing "I'll analyze this…" next
 * to "Claude encountered an error" (which reads as a contradiction).
 */
export const INITIAL_COMMENT_PLACEHOLDER =
  "I'll analyze this and get back to you.";

export function createCommentBody(
  jobRunLink: string,
  branchLink: string = "",
): string {
  return `Claude Code is working… ${SPINNER_HTML}

${INITIAL_COMMENT_PLACEHOLDER}

${jobRunLink}${branchLink}`;
}
