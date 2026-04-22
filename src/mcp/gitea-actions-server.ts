#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, writeFile } from "fs/promises";

const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const PR_NUMBER = process.env.PR_NUMBER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITEA_API_URL = process.env.GITEA_API_URL;
const RUNNER_TEMP = process.env.RUNNER_TEMP || "/tmp";

if (
  !REPO_OWNER ||
  !REPO_NAME ||
  !PR_NUMBER ||
  !GITHUB_TOKEN ||
  !GITEA_API_URL
) {
  console.error(
    "[Gitea Actions Server] Error: REPO_OWNER, REPO_NAME, PR_NUMBER, GITHUB_TOKEN, and GITEA_API_URL environment variables are required",
  );
  process.exit(1);
}

const baseHeaders = {
  Authorization: `token ${GITHUB_TOKEN}`,
  Accept: "application/json",
};

// Gitea 1.24's /actions/tasks list response shape. Fields are a strict subset
// of GitHub's ActionWorkflowRun — notably no `conclusion` and no `html_url`,
// and the title lives on `display_title`.
type ActionTask = {
  id: number;
  name?: string;
  display_title?: string;
  status: string;
  head_sha: string;
  head_branch?: string;
  event?: string;
  url?: string;
  run_number?: number;
  workflow_id?: string;
  created_at?: string;
  updated_at?: string;
  run_started_at?: string;
};

type TasksResponse = {
  workflow_runs: ActionTask[];
  total_count: number;
};

async function fetchPrHeadSha(
  owner: string,
  repo: string,
  prNumber: string,
): Promise<string> {
  const url = `${GITEA_API_URL}/repos/${owner}/${repo}/pulls/${prNumber}`;
  const res = await fetch(url, { headers: baseHeaders });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch PR ${prNumber}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as { head?: { sha?: string } };
  const sha = body.head?.sha;
  if (!sha) throw new Error(`PR ${prNumber} has no head.sha in response`);
  return sha;
}

async function listTasks(
  owner: string,
  repo: string,
  limit = 50,
): Promise<TasksResponse> {
  const url = `${GITEA_API_URL}/repos/${owner}/${repo}/actions/tasks?limit=${limit}`;
  const res = await fetch(url, { headers: baseHeaders });
  if (!res.ok) {
    throw new Error(
      `Failed to list action tasks: HTTP ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as TasksResponse;
}

// Gitea's /actions/tasks status strings are a subset of GitHub's. `conclusion`
// is not returned; "completed" is reported as the terminal success variant
// (`success` | `failure` | `cancelled` | `skipped`). So we classify by the
// status field alone.
function classify(status: string): "passed" | "failed" | "pending" {
  switch (status) {
    case "success":
      return "passed";
    case "failure":
    case "cancelled":
      return "failed";
    default:
      return "pending";
  }
}

const server = new McpServer({
  name: "Gitea Actions Server",
  version: "0.0.1",
});

console.error("[Gitea Actions Server] MCP Server instance created");

server.tool(
  "get_ci_status",
  "Summarize Gitea Actions tasks for the current PR (filters list by PR head SHA).",
  {
    status: z
      .enum([
        "waiting",
        "queued",
        "in_progress",
        "completed",
        "success",
        "failure",
        "cancelled",
        "skipped",
      ])
      .optional()
      .describe(
        "Filter tasks by Gitea status string. 'completed' matches any terminal state (success/failure/cancelled/skipped); 'success'/'failure'/etc. match only that exact terminal state.",
      ),
  },
  async ({ status }) => {
    try {
      const headSha = await fetchPrHeadSha(REPO_OWNER!, REPO_NAME!, PR_NUMBER!);
      const { workflow_runs } = await listTasks(REPO_OWNER!, REPO_NAME!);

      const prTasks = workflow_runs.filter((t) => t.head_sha === headSha);
      const summary = {
        total_runs: prTasks.length,
        failed: 0,
        passed: 0,
        pending: 0,
      };

      const terminalSet = new Set([
        "success",
        "failure",
        "cancelled",
        "skipped",
      ]);

      const processed = prTasks
        .filter((t) => {
          if (!status) return true;
          if (status === "completed") return terminalSet.has(t.status);
          return t.status === status;
        })
        .map((t) => {
          const cls = classify(t.status);
          summary[cls]++;
          return {
            id: t.id,
            name: t.name ?? t.display_title ?? null,
            status: t.status,
            head_sha: t.head_sha,
            url: t.url ?? null,
            run_number: t.run_number ?? null,
            created_at: t.created_at ?? t.run_started_at ?? null,
          };
        });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ summary, runs: processed }, null, 2),
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        error: msg,
        isError: true,
      };
    }
  },
);

server.tool(
  "get_workflow_run_details",
  "List the Gitea Actions tasks that belong to a given workflow run (grouped by run_number). Gitea 1.24 has no list-jobs endpoint and no step-level detail in its REST API, so this returns the sibling tasks sharing the run_number; use download_job_log(id) to inspect logs.",
  {
    run_number: z
      .number()
      .describe(
        "The run_number returned by get_ci_status.runs[].run_number (NOT the task id)",
      ),
  },
  async ({ run_number }) => {
    try {
      const { workflow_runs } = await listTasks(REPO_OWNER!, REPO_NAME!);
      const siblings = workflow_runs.filter((t) => t.run_number === run_number);

      const jobs = siblings.map((t) => ({
        id: t.id,
        name: t.name ?? t.display_title ?? null,
        status: t.status,
        classification: classify(t.status),
        url: t.url ?? null,
        head_sha: t.head_sha,
        created_at: t.created_at ?? t.run_started_at ?? null,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ run_number, jobs }, null, 2),
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        error: msg,
        isError: true,
      };
    }
  },
);

server.tool(
  "download_job_log",
  "Download the log for a Gitea Actions task to disk. `job_id` is the task id returned by get_ci_status.",
  {
    job_id: z
      .number()
      .describe("The task (job) id returned by get_ci_status.runs[].id"),
  },
  async ({ job_id }) => {
    try {
      const url = `${GITEA_API_URL}/repos/${REPO_OWNER}/${REPO_NAME}/actions/jobs/${job_id}/logs`;
      const res = await fetch(url, {
        headers: { ...baseHeaders, Accept: "text/plain" },
      });
      if (!res.ok) {
        throw new Error(
          `Failed to fetch log for job ${job_id}: HTTP ${res.status} ${res.statusText}`,
        );
      }
      const logsText = await res.text();

      const logsDir = `${RUNNER_TEMP}/gitea-actions-logs`;
      await mkdir(logsDir, { recursive: true });
      const logPath = `${logsDir}/job-${job_id}.log`;
      await writeFile(logPath, logsText, "utf-8");

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                path: logPath,
                size_bytes: Buffer.byteLength(logsText, "utf-8"),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        error: msg,
        isError: true,
      };
    }
  },
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Gitea Actions Server] MCP server running");
  process.on("exit", () => {
    server.close();
  });
}

runServer().catch((error) => {
  console.error("[Gitea Actions Server] Fatal error:", error);
  process.exit(1);
});
