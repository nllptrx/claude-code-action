#!/usr/bin/env bun

/**
 * Check if the action trigger is from a human actor
 * Prevents automated tools or bots from triggering Claude
 */

import type { GiteaApiClient } from "../api/gitea-client";
import type { GitHubContext } from "../context";

export async function checkHumanActor(
  api: GiteaApiClient,
  githubContext: GitHubContext,
) {
  // Check if we're in a Gitea environment
  const isGitea =
    process.env.GITEA_API_URL &&
    !process.env.GITEA_API_URL.includes("api.github.com");

  if (isGitea) {
    console.log(
      `Detected Gitea environment, skipping actor type validation for: ${githubContext.actor}`,
    );
    return;
  }

  try {
    // Fetch user information from GitHub API
    const response = await api.customRequest(
      "GET",
      `/users/${githubContext.actor}`,
    );
    const userData = response.data;

    const actorType = userData.type;

    console.log(`Actor type: ${actorType}`);

    if (actorType !== "User") {
      // Ported from upstream's checkHumanActor: honor allowed_bots for
      // non-User actors. GitHub-only — Gitea's User struct has no `type`
      // field so this branch isn't reachable in Gitea mode (which early-
      // returns above). The allowlist still applies if someone runs this
      // action against github.com.
      const allowedBots = githubContext.inputs.allowedBots ?? "";
      if (allowedBots.trim() === "*") {
        console.log(
          `All bots are allowed (allowed_bots='*'), skipping human actor check for: ${githubContext.actor}`,
        );
        return;
      }
      const allowedBotsList = allowedBots
        .split(",")
        .map((bot) =>
          bot
            .trim()
            .toLowerCase()
            .replace(/\[bot\]$/, ""),
        )
        .filter((bot) => bot.length > 0);
      const botName = githubContext.actor.toLowerCase().replace(/\[bot\]$/, "");
      if (allowedBotsList.includes(botName)) {
        console.log(
          `Bot ${botName} is in allowed_bots list, skipping human actor check`,
        );
        return;
      }
      throw new Error(
        `Workflow initiated by non-human actor: ${githubContext.actor} (type: ${actorType}). Add bot to allowed_bots list or use '*' to allow all bots.`,
      );
    }

    console.log(`Verified human actor: ${githubContext.actor}`);
  } catch (error) {
    console.warn(
      `Failed to check actor type for ${githubContext.actor}:`,
      error,
    );

    // For compatibility, assume human actor if API call fails
    console.log(
      `Assuming human actor due to API failure: ${githubContext.actor}`,
    );
  }
}
