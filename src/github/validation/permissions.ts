import * as core from "@actions/core";
import type { GitHubContext } from "../context";
import type { GiteaApiClient } from "../api/gitea-client";

/**
 * Check if the actor has write permissions to the repository.
 *
 * Ported from upstream's `checkWritePermissions` (GitHub flow) and adapted for
 * Gitea's API:
 *   - Bypass for users listed in `allowed_non_write_users` (comma list or '*').
 *     Only honored when an explicit `gitea_token` was provided, so an attacker
 *     can't flip the check by compromising the default workflow token alone.
 *   - Bot actors (username ending in "[bot]") are allowed. Gitea doesn't have
 *     GitHub's app-bot convention, but some deployments mirror the suffix
 *     (e.g., `renovate[bot]`) — kept for parity and harmless otherwise.
 *   - Actor-specific check via `GET /repos/:owner/:repo/collaborators/:user/permission`
 *     (Gitea: RepoCollaboratorPermission, same shape as GitHub).
 *   - Fallback: legacy gitea behavior — when that endpoint is unreachable
 *     (older Gitea, missing perms on the token), fall back to the token's own
 *     `repo.permissions` field and the "no permissions = workflow token"
 *     assumption. Preserves the pre-port behavior for deployments that never
 *     set `allowed_non_write_users`.
 *
 * @param api - Gitea API client
 * @param context - The parsed Gitea/GitHub context
 * @param allowedNonWriteUsers - Comma list of usernames to allow without
 *   write permissions, or '*' for all. Only effective when `giteaTokenProvided`.
 * @param giteaTokenProvided - Whether `gitea_token` / `OVERRIDE_GITHUB_TOKEN`
 *   was explicitly set (i.e., not using the default workflow token).
 */
export async function checkWritePermissions(
  api: GiteaApiClient,
  context: GitHubContext,
  allowedNonWriteUsers?: string,
  giteaTokenProvided?: boolean,
): Promise<boolean> {
  const { repository, actor } = context;

  // Bypass list — only honored when an explicit gitea_token was provided.
  if (allowedNonWriteUsers && giteaTokenProvided) {
    const trimmed = allowedNonWriteUsers.trim();
    if (trimmed === "*") {
      core.warning(
        `⚠️ SECURITY WARNING: Bypassing write permission check for ${actor} ` +
          `due to allowed_non_write_users='*'. Only use for workflows with ` +
          `very limited permissions.`,
      );
      return true;
    } else if (trimmed.length > 0) {
      const allowed = trimmed
        .split(",")
        .map((u) => u.trim())
        .filter((u) => u.length > 0);
      if (allowed.includes(actor)) {
        core.warning(
          `⚠️ SECURITY WARNING: Bypassing write permission check for ${actor} ` +
            `due to allowed_non_write_users configuration. Only use for ` +
            `workflows with very limited permissions.`,
        );
        return true;
      }
    }
  }

  // Bot suffix — harmless on Gitea if unused, matches upstream.
  if (actor.endsWith("[bot]")) {
    core.info(`Actor is a bot: ${actor}`);
    return true;
  }

  // Primary check: Gitea collaborator permission endpoint.
  try {
    const resp = await api.getCollaboratorPermission(
      repository.owner,
      repository.repo,
      actor,
    );
    const level = resp.data.permission;
    core.info(`Permission level for ${actor}: ${level}`);
    if (level === "admin" || level === "write") {
      return true;
    }
    core.warning(`Actor ${actor} lacks write access: ${level}`);
    return false;
  } catch (collaboratorError) {
    // Fallback: older Gitea or tokens without collaborator:read — use the
    // token's own repo permissions. Matches pre-port behavior so existing
    // deployments don't regress.
    core.info(
      `Collaborator permission endpoint failed for ${actor} (${collaboratorError}); ` +
        `falling back to workflow token's repo.permissions.`,
    );
    try {
      const response = await api.getRepo(repository.owner, repository.repo);
      const perms = response.data.permissions;
      if (!perms) {
        core.info(
          `No permissions field in repo response (Gitea workflow token); ` +
            `assuming write access for ${actor}.`,
        );
        return true;
      }
      if (perms.admin || perms.push) {
        core.info(
          `Actor ${actor} has write access (admin=${perms.admin}, push=${perms.push})`,
        );
        return true;
      }
      core.warning(
        `Actor ${actor} lacks write access: ${JSON.stringify(perms)}`,
      );
      return false;
    } catch (fallbackError) {
      core.error(`Failed to check permissions for ${actor}: ${fallbackError}`);
      throw new Error(
        `Failed to check permissions for ${actor}: ${fallbackError}`,
      );
    }
  }
}
