import * as core from "@actions/core";
import type { GitHubContext } from "../github/context";
import { isEntityContext } from "../github/context";
import { getServerUrl } from "../github/api/config";

/**
 * Resolve the Gitea API URL at call time rather than module-load time.
 * The module-level `GITEA_API_URL` constant in `../github/api/config` is
 * frozen on first import, which made prepareMcpConfig observe stale values
 * when tests mutate `process.env.GITEA_API_URL` after import (test-order
 * dependent; locally passed, CI failed).
 */
function deriveApiUrlAtRuntime(): string {
  const explicit = process.env.GITEA_API_URL;
  if (explicit && explicit.trim() !== "") return explicit;
  const serverUrl = getServerUrl();
  if (serverUrl.includes("github.com")) return "https://api.github.com";
  return `${serverUrl}/api/v1`;
}

/**
 * Probe that the provided token has repo-read access to the Actions unit on
 * Gitea by hitting `/actions/tasks` with limit=1. On success the token can
 * list runs; on 403 the token lacks the Actions read permission (or the unit
 * is disabled on the repo); on network/other errors we conservatively return
 * false and let the caller skip server registration.
 */
async function checkGiteaActionsReadPermission(
  token: string,
  owner: string,
  repo: string,
  apiUrl: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${apiUrl}/repos/${owner}/${repo}/actions/tasks?limit=1`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
        },
      },
    );
    if (res.ok) return true;
    if (res.status === 403 || res.status === 404) return false;
    core.debug(
      `Unexpected status probing /actions/tasks: ${res.status} ${res.statusText}`,
    );
    return false;
  } catch (error) {
    core.debug(
      `Failed to probe Gitea actions permission: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export type PrepareMcpConfigOptions = {
  githubToken: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch?: string;
  allowedTools?: string[];
  context?: GitHubContext;
  overrideConfig?: string;
  additionalMcpConfig?: string;
};

export async function prepareMcpConfig({
  githubToken,
  owner,
  repo,
  branch,
  context,
}: PrepareMcpConfigOptions): Promise<string> {
  console.log("[MCP-INSTALL] Preparing MCP configuration...");
  console.log(`[MCP-INSTALL] Owner: ${owner}`);
  console.log(`[MCP-INSTALL] Repo: ${repo}`);
  console.log(`[MCP-INSTALL] Branch: ${branch}`);
  console.log(
    `[MCP-INSTALL] GitHub token: ${githubToken ? "***" : "undefined"}`,
  );
  console.log(
    `[MCP-INSTALL] GITHUB_ACTION_PATH: ${process.env.GITHUB_ACTION_PATH}`,
  );
  console.log(
    `[MCP-INSTALL] GITHUB_WORKSPACE: ${process.env.GITHUB_WORKSPACE}`,
  );

  try {
    const apiUrl = deriveApiUrlAtRuntime();
    const mcpConfig: { mcpServers: Record<string, unknown> } = {
      mcpServers: {
        gitea: {
          command: "bun",
          args: [
            "run",
            `${process.env.GITHUB_ACTION_PATH}/src/mcp/gitea-mcp-server.ts`,
          ],
          env: {
            GITHUB_TOKEN: githubToken,
            REPO_OWNER: owner,
            REPO_NAME: repo,
            BRANCH_NAME: branch,
            REPO_DIR: process.env.GITHUB_WORKSPACE || process.cwd(),
            GITEA_API_URL: apiUrl,
          },
        },
        local_git_ops: {
          command: "bun",
          args: [
            "run",
            `${process.env.GITHUB_ACTION_PATH}/src/mcp/local-git-ops-server.ts`,
          ],
          env: {
            GITHUB_TOKEN: githubToken,
            REPO_OWNER: owner,
            REPO_NAME: repo,
            BRANCH_NAME: branch,
            REPO_DIR: process.env.GITHUB_WORKSPACE || process.cwd(),
            GITEA_API_URL: apiUrl,
          },
        },
      },
    };

    // Conditionally register the gitea_actions MCP server when
    // `additional_permissions: actions: read` is set on a PR context. Gitea-
    // native server: hits `/actions/tasks` (not `/actions/runs`, which doesn't
    // exist on Gitea 1.24). On github.com we skip registration with a warning
    // — the server's endpoints don't have GitHub equivalents.
    if (context && isEntityContext(context) && context.isPR) {
      const wantsActionsRead =
        context.inputs.additionalPermissions.get("actions") === "read";

      if (wantsActionsRead) {
        const isGitHub = apiUrl.includes("api.github.com");
        if (isGitHub) {
          core.warning(
            "gitea_actions MCP server targets Gitea's /actions/tasks endpoint and is not wired for github.com. " +
              "CI introspection tools will be unavailable on this run.",
          );
        } else {
          const hasPermission = await checkGiteaActionsReadPermission(
            githubToken,
            owner,
            repo,
            apiUrl,
          );
          if (!hasPermission) {
            core.warning(
              "gitea_actions MCP server requires repo-read access with the Actions unit enabled. " +
                "The probe to /actions/tasks failed. Verify token scope + repo Actions settings, " +
                "or remove `additional_permissions: actions: read` from the workflow.",
            );
          } else {
            mcpConfig.mcpServers.gitea_actions = {
              command: "bun",
              args: [
                "run",
                `${process.env.GITHUB_ACTION_PATH}/src/mcp/gitea-actions-server.ts`,
              ],
              env: {
                GITHUB_TOKEN: githubToken,
                REPO_OWNER: owner,
                REPO_NAME: repo,
                PR_NUMBER: context.entityNumber.toString(),
                RUNNER_TEMP: process.env.RUNNER_TEMP || "/tmp",
                GITEA_API_URL: apiUrl,
              },
            };
          }
        }
      }
    }

    const configString = JSON.stringify(mcpConfig, null, 2);
    console.log("[MCP-INSTALL] Generated MCP configuration:");
    console.log(configString);
    console.log("[MCP-INSTALL] MCP config generation completed successfully");

    return configString;
  } catch (error) {
    console.error("[MCP-INSTALL] MCP config generation failed:", error);
    // Re-throw instead of process.exit so the unified run.ts catch/finally
    // can publish prepare_success=false + prepare_error for update-comment-link.
    throw new Error(`Install MCP server failed with error: ${error}`);
  }
}
