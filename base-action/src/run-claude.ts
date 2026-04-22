import { runClaudeWithSdk } from "./run-claude-sdk";
import type { ClaudeRunResult } from "./run-claude-sdk";
import { parseSdkOptions } from "./parse-sdk-options";

export type ClaudeOptions = {
  claudeArgs?: string;
  model?: string;
  pathToClaudeCodeExecutable?: string;
  allowedTools?: string;
  disallowedTools?: string;
  maxTurns?: string;
  mcpConfig?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  fallbackModel?: string;
  showFullOutput?: string;
  /**
   * YAML-multiline string of KEY: value pairs passed to Claude's execution
   * environment. Preserved across the upstream switch from the CLI subprocess
   * (which parsed it natively) to the SDK path (which inherits from
   * `process.env`), so existing Gitea workflows that rely on it keep working.
   */
  claudeEnv?: string;
};

function parseClaudeEnv(yamlish?: string): Record<string, string> {
  if (!yamlish || yamlish.trim() === "") return {};
  const env: Record<string, string> = {};
  for (const rawLine of yamlish.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

export async function runClaude(
  promptPath: string,
  options: ClaudeOptions,
): Promise<ClaudeRunResult> {
  // Inject claude_env KEY: value pairs into process.env BEFORE parseSdkOptions
  // reads it — parseSdkOptions seeds the SDK's env from process.env, so the
  // values propagate into Claude's execution context.
  const customEnv = parseClaudeEnv(options.claudeEnv);
  for (const [k, v] of Object.entries(customEnv)) {
    process.env[k] = v;
  }
  const parsedOptions = parseSdkOptions(options);
  return runClaudeWithSdk(promptPath, parsedOptions);
}
