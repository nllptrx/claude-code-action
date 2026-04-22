#!/usr/bin/env bun

/**
 * Unified entrypoint for the Claude Code Action (Gitea fork).
 *
 * Replaces the former 2-step wiring of `prepare.ts` + external
 * `anthropics/claude-code-base-action@v0.0.63` with a single in-process
 * orchestrator that calls the local `./base-action/` code directly.
 *
 * `update-comment-link.ts` remains a separate action.yml step — it runs in
 * the cleanup phase with `if: always()` and reads outputs set here.
 */

import * as core from "@actions/core";
import { dirname } from "path";
import { spawn } from "child_process";
import { appendFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { setupGitHubToken } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { createClient } from "../github/api/client";
import {
  parseGitHubContext,
  isEntityContext,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
} from "../github/context";
import type { GitHubContext } from "../github/context";
import { prepareTagMode } from "../modes/tag";
import { prepareAgentMode } from "../modes/agent";
import { checkContainsTrigger } from "../github/validation/trigger";
import { restoreConfigFromBase } from "../github/operations/restore-config";
import { validateBranchName } from "../github/operations/branch";
import { collectActionInputsPresence } from "./collect-inputs";
import { formatTurnsFromData, type Turn } from "./format-turns";
// Base-action imports (used directly instead of subprocess)
import { validateEnvironmentVariables } from "../../base-action/src/validate-env";
import { setupClaudeCodeSettings } from "../../base-action/src/setup-claude-code-settings";
import { installPlugins } from "../../base-action/src/install-plugins";
import { preparePrompt } from "../../base-action/src/prepare-prompt";
import { runClaude } from "../../base-action/src/run-claude";

/**
 * Install the Claude Code CLI binary, with retries, and add its directory to PATH.
 * Returns the absolute path to the `claude` executable.
 */
async function installClaudeCode(): Promise<string> {
  const customExecutable = process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE;
  if (customExecutable) {
    if (/[\x00-\x1f\x7f]/.test(customExecutable)) {
      throw new Error(
        "PATH_TO_CLAUDE_CODE_EXECUTABLE contains control characters (e.g. newlines), which is not allowed",
      );
    }
    console.log(`Using custom Claude Code executable: ${customExecutable}`);
    const claudeDir = dirname(customExecutable);
    const githubPath = process.env.GITHUB_PATH;
    if (githubPath) {
      await appendFile(githubPath, `${claudeDir}\n`);
    }
    process.env.PATH = `${claudeDir}:${process.env.PATH}`;
    return customExecutable;
  }

  const claudeCodeVersion = "2.1.117";
  console.log(`Installing Claude Code v${claudeCodeVersion}...`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`Installation attempt ${attempt}...`);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "bash",
          [
            "-c",
            `curl -fsSL https://claude.ai/install.sh | bash -s -- ${claudeCodeVersion}`,
          ],
          { stdio: "inherit" },
        );
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Install failed with exit code ${code}`));
        });
        child.on("error", reject);
      });
      console.log("Claude Code installed successfully");
      const homeBin = `${process.env.HOME}/.local/bin`;
      const githubPath = process.env.GITHUB_PATH;
      if (githubPath) {
        await appendFile(githubPath, `${homeBin}\n`);
      }
      process.env.PATH = `${homeBin}:${process.env.PATH}`;
      return `${homeBin}/claude`;
    } catch (error) {
      if (attempt === 3) {
        throw new Error(
          `Failed to install Claude Code after 3 attempts: ${error}`,
        );
      }
      console.log("Installation failed, retrying...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw new Error("unreachable");
}

async function writeStepSummary(executionFile: string): Promise<void> {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  try {
    const fileContent = readFileSync(executionFile, "utf-8");
    const data: Turn[] = JSON.parse(fileContent);
    const markdown = formatTurnsFromData(data);
    await appendFile(summaryFile, markdown);
    console.log("Successfully formatted Claude Code report");
  } catch (error) {
    console.error(`Failed to format output: ${error}`);
    try {
      let fallback = "## Claude Code Report (Raw Output)\n\n";
      fallback +=
        "Failed to format output (please report). Here's the raw JSON:\n\n";
      fallback += "```json\n";
      fallback += readFileSync(executionFile, "utf-8");
      fallback += "\n```\n";
      await appendFile(summaryFile, fallback);
    } catch {
      console.error("Failed to write raw output to step summary");
    }
  }
}

/**
 * Build the claudeArgs string passed to the base-action SDK wrapper.
 *
 * `parseSdkOptions` only extracts `--mcp-config` from the claudeArgs string
 * (the separate `options.mcpConfig` field is ignored), so we have to embed
 * the action-generated MCP config (gitea / local_git_ops servers) as a CLI
 * flag at the head of the string. User-supplied `CLAUDE_ARGS` is appended;
 * if they also pass `--mcp-config`, parseSdkOptions' mergeMcpConfigs
 * combines both server dicts.
 *
 * Exported for testing.
 */
export function buildClaudeArgs(
  mcpConfig: string,
  userClaudeArgs: string | undefined,
): string {
  const escaped = mcpConfig.replace(/'/g, "'\\''");
  const parts = [`--mcp-config '${escaped}'`];
  if (userClaudeArgs && userClaudeArgs.trim()) {
    parts.push(userClaudeArgs.trim());
  }
  return parts.join(" ");
}

/**
 * Emit Gitea bot noreply email outputs when bot_id/bot_name are set,
 * so downstream steps (e.g. checkout with persist-credentials) can pick up
 * the same commit identity `configureGitAuth` writes to git config.
 *
 * Hostname resolution mirrors `configureGitAuth`: prefers GITEA_SERVER_URL,
 * falls back to GITHUB_SERVER_URL, then github.com.
 */
async function emitBotNoreplyOutputs(context: GitHubContext): Promise<void> {
  const botId = context.inputs.botId?.trim() ?? "";
  const botName = context.inputs.botName?.trim() ?? "";
  if (!(botId && botName && /^\d+$/.test(botId))) return;

  const { GITEA_SERVER_URL } = await import("../github/api/config");
  let hostname = "github.com";
  try {
    hostname = new URL(GITEA_SERVER_URL).hostname;
  } catch {
    // Fall back to github.com
  }
  const noreplyDomain =
    hostname === "github.com"
      ? "users.noreply.github.com"
      : `users.noreply.${hostname}`;
  core.setOutput("effective_git_name", botName);
  core.setOutput(
    "effective_git_email",
    `${botId}+${botName}@${noreplyDomain}`,
  );
  console.log(
    `Effective git author from bot_id/bot_name: ${botName} <${botId}+${botName}@${noreplyDomain}>`,
  );
}

async function run() {
  let githubToken: string | undefined;
  let claudeBranch: string | undefined;
  let baseBranch: string | undefined;
  let executionFile: string | undefined;
  let claudeSuccess = false;
  let prepareSuccess = true;
  let prepareError: string | undefined;
  let context: GitHubContext | undefined;
  let prepareCompleted = false;

  try {
    console.log("=== Claude Action Run Starting ===");
    console.log("Event name:", process.env.GITHUB_EVENT_NAME);
    console.log("Repository:", process.env.GITHUB_REPOSITORY);

    const actionInputsPresent = collectActionInputsPresence();

    context = parseGitHubContext();
    githubToken = await setupGitHubToken();
    const client = createClient(githubToken);

    // Set GITHUB_TOKEN/GH_TOKEN in process env for downstream usage
    process.env.GITHUB_TOKEN = githubToken;
    process.env.GH_TOKEN = githubToken;

    if (isEntityContext(context)) {
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
    }

    const modeName = context.inputs.mode;
    console.log(`Using configured mode: ${modeName}`);

    // Agent mode activates when the user supplies any prompt-bearing input.
    // createAgentPrompt consumes direct_prompt / override_prompt; the
    // published `prompt` input is an alias promoted to direct_prompt inside
    // prepareAgentMode.
    const containsTrigger =
      modeName === "tag"
        ? isEntityContext(context) && checkContainsTrigger(context)
        : !!(
            context.inputs.directPrompt ||
            context.inputs.overridePrompt ||
            context.inputs.prompt
          );
    core.setOutput("contains_trigger", containsTrigger.toString());

    // Emit bot noreply outputs regardless of trigger — harmless when unused
    // and needed by any downstream step that runs even on skipped triggers.
    await emitBotNoreplyOutputs(context);

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      return;
    }

    console.log(
      `Preparing with mode: ${modeName} for event: ${context.eventName}`,
    );
    const prepareResult =
      modeName === "tag"
        ? await prepareTagMode({ context, client, githubToken })
        : await prepareAgentMode({ context, client, githubToken });

    claudeBranch = prepareResult.branchInfo.claudeBranch;
    baseBranch = prepareResult.branchInfo.baseBranch;
    prepareCompleted = true;

    // claude_comment_id is emitted inside prepareTagMode at the creation
    // site so later failures still let update-comment-link rewrite the
    // placeholder into an error link.
    if (baseBranch) {
      core.setOutput("BASE_BRANCH", baseBranch);
    }
    if (claudeBranch) {
      core.setOutput("CLAUDE_BRANCH", claudeBranch);
    }
    core.setOutput("mcp_config", prepareResult.mcpConfig);

    const claudeExecutable = await installClaudeCode();

    // Env vars expected by base-action code
    process.env.INPUT_ACTION_INPUTS_PRESENT = actionInputsPresent;
    process.env.CLAUDE_CODE_ACTION = "1";
    process.env.DETAILED_PERMISSION_MESSAGES = "1";

    validateEnvironmentVariables();

    // On PRs the checked-out .claude/ and .mcp.json may be attacker-controlled.
    // Restore them from the PR's base branch (or mode-provided base) before
    // Claude reads them.
    if (isEntityContext(context) && context.isPR) {
      let restoreBase: string | undefined = baseBranch;
      if (
        isPullRequestEvent(context) ||
        isPullRequestReviewEvent(context) ||
        isPullRequestReviewCommentEvent(context)
      ) {
        restoreBase = context.payload.pull_request.base.ref;
        validateBranchName(restoreBase);
      }
      if (restoreBase) {
        restoreConfigFromBase(restoreBase);
      }
    }

    await setupClaudeCodeSettings(process.env.INPUT_SETTINGS);

    await installPlugins(
      process.env.INPUT_PLUGIN_MARKETPLACES,
      process.env.INPUT_PLUGINS,
      claudeExecutable,
    );

    const promptFile =
      process.env.INPUT_PROMPT_FILE ||
      `${process.env.RUNNER_TEMP || "/tmp"}/claude-prompts/claude-prompt.txt`;
    const promptConfig = await preparePrompt({ prompt: "", promptFile });

    const claudeArgs = buildClaudeArgs(
      prepareResult.mcpConfig,
      process.env.CLAUDE_ARGS,
    );

    // Execution-file path is a constant the SDK writes BEFORE throwing on
    // failure. Capture it up-front so a thrown runClaudeWithSdk still leaves
    // the log attached for update-comment-link / step summary.
    const sdkExecutionFile = `${process.env.RUNNER_TEMP || "/tmp"}/claude-execution-output.json`;

    // Hard per-invocation timeout. The SDK `query()` iterator exposes no
    // cancellation API, so a Promise.race alone would only reject the outer
    // await while the generator keeps running. Force a process exit so the
    // runner reaps the step — matches the v0.0.63 subprocess semantics.
    //
    // `process.exit` bypasses the outer try/finally, so emit every output
    // update-comment-link + the step summary rely on BEFORE exiting:
    // conclusion, execution_file (SDK wrote it on its way to the timeout),
    // branch_name, claude_success, prepare_success.
    // Validate timeout_minutes and max_turns strictly. An empty value means
    // "use runner default" and is allowed; anything else must parse to a
    // positive integer. Silent coercion to NaN-as-disabled used to let
    // misconfigured workflows run unbounded.
    const timeoutMinutesRaw = process.env.TIMEOUT_MINUTES ?? "";
    let timeoutMinutes = 0;
    if (timeoutMinutesRaw.trim() !== "") {
      const parsed = parseInt(timeoutMinutesRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
          `timeout_minutes must be a positive integer, got: '${timeoutMinutesRaw}'`,
        );
      }
      timeoutMinutes = parsed;
    }
    const maxTurnsRaw = process.env.MAX_TURNS ?? "";
    if (maxTurnsRaw.trim() !== "") {
      const parsed = parseInt(maxTurnsRaw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
          `max_turns must be a positive integer, got: '${maxTurnsRaw}'`,
        );
      }
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    if (timeoutMinutes > 0) {
      timeoutHandle = setTimeout(
        () => {
          core.setFailed(
            `Claude execution exceeded timeout_minutes=${timeoutMinutes}`,
          );
          const sdkOutFile = `${process.env.RUNNER_TEMP || "/tmp"}/claude-execution-output.json`;
          if (existsSync(sdkOutFile)) {
            core.setOutput("execution_file", sdkOutFile);
          }
          core.setOutput("conclusion", "failure");
          core.setOutput("claude_success", "false");
          core.setOutput("prepare_success", "true");
          core.setOutput("branch_name", claudeBranch ?? "");
          // Exit code 124 matches `timeout(1)` and the previous CLI path.
          process.exit(124);
        },
        timeoutMinutes * 60 * 1000,
      );
      timeoutHandle.unref();
    }

    try {
      const claudeResult = await runClaude(promptConfig.path, {
        claudeArgs,
        allowedTools: process.env.ALLOWED_TOOLS,
        disallowedTools: process.env.DISALLOWED_TOOLS,
        maxTurns: process.env.MAX_TURNS,
        systemPrompt: process.env.SYSTEM_PROMPT,
        appendSystemPrompt: process.env.APPEND_SYSTEM_PROMPT,
        fallbackModel: process.env.FALLBACK_MODEL,
        model: process.env.ANTHROPIC_MODEL,
        pathToClaudeCodeExecutable: claudeExecutable,
        showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
        claudeEnv: process.env.CLAUDE_ENV,
      });
      if (timeoutHandle) clearTimeout(timeoutHandle);

      claudeSuccess = claudeResult.conclusion === "success";
      executionFile = claudeResult.executionFile ?? sdkExecutionFile;

      if (executionFile) {
        core.setOutput("execution_file", executionFile);
      }
      if (claudeResult.sessionId) {
        core.setOutput("session_id", claudeResult.sessionId);
      }
      if (claudeResult.structuredOutput) {
        core.setOutput("structured_output", claudeResult.structuredOutput);
      }
      core.setOutput("conclusion", claudeResult.conclusion);
    } catch (sdkError) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // runClaudeWithSdk throws on non-success results AFTER writing the
      // execution file. Re-throw to propagate the failure, but first record
      // the execution file path so the step-summary and follow-up comment
      // keep the debug log.
      claudeSuccess = false;
      if (existsSync(sdkExecutionFile)) {
        executionFile = sdkExecutionFile;
        core.setOutput("execution_file", sdkExecutionFile);
      }
      core.setOutput("conclusion", "failure");
      throw sdkError;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!prepareCompleted) {
      prepareSuccess = false;
      prepareError = errorMessage;
      core.setOutput("prepare_error", errorMessage);
    }
    core.setFailed(`Action failed with error: ${errorMessage}`);
  } finally {
    if (
      executionFile &&
      existsSync(executionFile) &&
      process.env.DISPLAY_REPORT !== "false"
    ) {
      await writeStepSummary(executionFile);
    }

    core.setOutput("branch_name", claudeBranch ?? "");
    core.setOutput("claude_success", claudeSuccess ? "true" : "false");
    core.setOutput("prepare_success", prepareSuccess ? "true" : "false");
    if (!prepareSuccess && prepareError) {
      core.setOutput("prepare_error", prepareError);
    }
  }
}

if (import.meta.main) {
  run();
}
