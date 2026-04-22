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

  // Repo owner short-circuit. Gitea's collaborator endpoint returns 403 for
  // the owner's own lookup because owners aren't stored in the collaborators
  // table ("collaborators can query only their own"). The owner obviously
  // has write, so skip the API call entirely.
  if (actor === repository.owner) {
    core.info(`Actor ${actor} is the repository owner`);
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
  } catch (collaboratorError: any) {
    const status = collaboratorError?.status;
    const msg = String(collaboratorError?.message ?? "");

    // Gitea returns 403 with this exact error message ("collaborators can query
    // only their own") when the workflow token lacks permission to look up the
    // actor. On Gitea the workflow token isn't a repo admin, so this fires for
    // every non-owner non-collaborator actor. Falling back to the token's own
    // repo.permissions in this case is unsafe — workflow tokens always have
    // push, which would effectively grant write to anyone who can trigger the
    // workflow. Fail closed.
    if (
      status === 403 &&
      /query only their own|can query all permissions/.test(msg)
    ) {
      core.warning(
        `Actor ${actor} is not a repository collaborator (Gitea's permission ` +
          `endpoint rejected the lookup with 403). Denying write access. ` +
          `To allow this actor, add them to the repo's collaborators list, or ` +
          `grant an explicit bypass via the allowed_non_write_users input.`,
      );
      return false;
    }

    // Other errors (connection issues, missing endpoint on older Gitea, etc.)
    // — fall back to the token's repo.permissions so those legacy deployments
    // don't regress. A broken endpoint is less dangerous than a connection
    // failure masquerading as "no access".
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
