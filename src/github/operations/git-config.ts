#!/usr/bin/env bun

/**
 * Configure git authentication for non-signing mode
 * Sets up git user and authentication to work with GitHub App tokens
 */

import { $ } from "bun";
import { join } from "path";
import { homedir } from "os";
import { mkdir, writeFile, rm } from "fs/promises";
import type { GitHubContext } from "../context";
import { GITEA_SERVER_URL } from "../api/config";

const SSH_SIGNING_KEY_PATH = join(homedir(), ".ssh", "claude_signing_key");

type GitUser = {
  login: string;
  id: number;
};

/**
 * Build a GitUser from the action's `bot_id` / `bot_name` inputs when set.
 * Returns null when either input is missing/empty or botId isn't a positive
 * integer. Callers can pass the result as the `user` arg to
 * `configureGitAuth` to force a specific account identity for git commits.
 *
 * Ported from upstream's modes/{agent,tag}/index.ts pattern:
 *   const user = { login: context.inputs.botName, id: parseInt(context.inputs.botId) };
 */
export function getBotUserFromInputs(
  context: GitHubContext,
): GitUser | null {
  const botName = context.inputs.botName?.trim();
  const botId = context.inputs.botId?.trim();
  if (!botName || !botId) return null;
  const id = parseInt(botId, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { login: botName, id };
}

export async function configureGitAuth(
  githubToken: string,
  context: GitHubContext,
  user: GitUser | null,
) {
  console.log("Configuring git authentication for non-signing mode");

  // Determine the noreply email domain based on GITHUB_SERVER_URL
  const serverUrl = new URL(GITEA_SERVER_URL);
  const noreplyDomain =
    serverUrl.hostname === "github.com"
      ? "users.noreply.github.com"
      : `users.noreply.${serverUrl.hostname}`;

  // Configure git user — priority order:
  //  1. Explicit `user` arg (e.g., the comment creator for author-preserving
  //     commits).
  //  2. `bot_id` / `bot_name` action inputs (via getBotUserFromInputs) —
  //     lets maintainers pin the action to a specific bot account without
  //     touching the caller.
  //  3. `claude_git_name` / `claude_git_email` action inputs (exposed as the
  //     CLAUDE_GIT_NAME / CLAUDE_GIT_EMAIL env vars). Before the unified
  //     entrypoint, these were only honored by ensureGitUserConfigured in
  //     local-git-ops-server, which skips when config is already set —
  //     calling configureGitAuth earlier now would otherwise strand the
  //     inputs, so honor them here.
  //  4. Hard-coded github-actions[bot] fallback (legacy behavior).
  console.log("Configuring git user...");
  const resolvedUser = user ?? getBotUserFromInputs(context);
  if (resolvedUser) {
    const botName = resolvedUser.login;
    const botId = resolvedUser.id;
    console.log(`Setting git user as ${botName}...`);
    await $`git config user.name "${botName}"`;
    await $`git config user.email "${botId}+${botName}@${noreplyDomain}"`;
    console.log(`✓ Set git user as ${botName}`);
  } else if (process.env.CLAUDE_GIT_NAME || process.env.CLAUDE_GIT_EMAIL) {
    const gitName = process.env.CLAUDE_GIT_NAME || "Claude";
    const gitEmail = process.env.CLAUDE_GIT_EMAIL || "claude@anthropic.com";
    console.log(`Setting git user from claude_git_* inputs: ${gitName}`);
    await $`git config user.name "${gitName}"`;
    await $`git config user.email "${gitEmail}"`;
  } else {
    console.log(
      "No user data in comment, no bot_id/bot_name, no claude_git_*; using default bot user",
    );
    await $`git config user.name "github-actions[bot]"`;
    await $`git config user.email "41898282+github-actions[bot]@${noreplyDomain}"`;
  }

  // Remove the authorization header that actions/checkout sets
  console.log("Removing existing git authentication headers...");
  try {
    await $`git config --unset-all http.${GITEA_SERVER_URL}/.extraheader`;
    console.log("✓ Removed existing authentication headers");
  } catch (e) {
    console.log("No existing authentication headers to remove");
  }

  if (process.env.ALLOWED_NON_WRITE_USERS) {
    // When processing content from non-write users, use a credential helper
    // instead of embedding the token in the remote URL. The helper script reads
    // from GH_TOKEN at auth time, so .git/config stays token-free. Written as a
    // file to avoid shell-escaping the helper body; placed under
    // GITHUB_ACTION_PATH so it sits alongside the action source.
    console.log("Configuring git credential helper...");
    process.env.GH_TOKEN = githubToken;
    const helperPath = join(
      process.env.GITHUB_ACTION_PATH || homedir(),
      ".git-credential-gh-token",
    );
    await writeFile(
      helperPath,
      '#!/bin/sh\necho username=x-access-token\necho password="$GH_TOKEN"\n',
      { mode: 0o700 },
    );
    const cleanUrl = `${serverUrl.protocol}//${serverUrl.host}/${context.repository.owner}/${context.repository.repo}.git`;
    await $`git remote set-url origin ${cleanUrl}`;
    await $`git config credential.helper ${helperPath}`;
    console.log("✓ Configured credential helper");
  } else {
    // Update the remote URL to include the token for authentication
    console.log("Updating remote URL with authentication...");
    // URL.protocol includes the trailing colon (e.g. "http:"), so the
    // expression renders "http://host" or "https://host" correctly — Gitea
    // dev instances listen on HTTP; hardcoding https here broke PR-event
    // runs when restoreConfigFromBase invoked `git fetch`.
    const remoteUrl = `${serverUrl.protocol}//x-access-token:${githubToken}@${serverUrl.host}/${context.repository.owner}/${context.repository.repo}.git`;
    await $`git remote set-url origin ${remoteUrl}`;
    console.log("✓ Updated remote URL with authentication token");
  }

  console.log("Git authentication configured successfully");
}

/**
 * Configure git to use SSH signing for commits
 * This is an alternative to GitHub API-based commit signing (use_commit_signing)
 */
export async function setupSshSigning(sshSigningKey: string): Promise<void> {
  console.log("Configuring SSH signing for commits...");

  // Validate SSH key format
  if (!sshSigningKey.trim()) {
    throw new Error("SSH signing key cannot be empty");
  }
  if (
    !sshSigningKey.includes("BEGIN") ||
    !sshSigningKey.includes("PRIVATE KEY")
  ) {
    throw new Error("Invalid SSH private key format");
  }

  // Create .ssh directory with secure permissions (700)
  const sshDir = join(homedir(), ".ssh");
  await mkdir(sshDir, { recursive: true, mode: 0o700 });

  // Ensure key ends with newline (required for ssh-keygen to parse it)
  const normalizedKey = sshSigningKey.endsWith("\n")
    ? sshSigningKey
    : sshSigningKey + "\n";

  // Write the signing key atomically with secure permissions (600)
  await writeFile(SSH_SIGNING_KEY_PATH, normalizedKey, { mode: 0o600 });
  console.log(`✓ SSH signing key written to ${SSH_SIGNING_KEY_PATH}`);

  // Configure git to use SSH signing
  await $`git config gpg.format ssh`;
  await $`git config user.signingkey ${SSH_SIGNING_KEY_PATH}`;
  await $`git config commit.gpgsign true`;

  console.log("✓ Git configured to use SSH signing for commits");
}

/**
 * Clean up the SSH signing key file
 * Should be called in the post step for security
 */
export async function cleanupSshSigning(): Promise<void> {
  try {
    await rm(SSH_SIGNING_KEY_PATH, { force: true });
    console.log("✓ SSH signing key cleaned up");
  } catch (error) {
    console.log("No SSH signing key to clean up");
  }
}
