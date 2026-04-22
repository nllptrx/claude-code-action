import type { GitHubContext } from "../github/context";
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
    const mcpConfig = {
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
            GITEA_API_URL: deriveApiUrlAtRuntime(),
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
            GITEA_API_URL: deriveApiUrlAtRuntime(),
          },
        },
      },
    };

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
