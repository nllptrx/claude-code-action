#!/usr/bin/env bun
/**
 * Gitea E2E harness.
 *
 *   bun scripts/e2e-gitea/e2e.ts <subcommand> [args...]
 *
 * Subcommands:
 *   up                             Bring up the stack; create users/repos; install workflow.
 *   down                           Tear down + wipe data dirs + remove token files.
 *   status                         Print containers, latest runs, open PRs.
 *   secret NAME                    Set a repo secret (reads value from stdin).
 *   trigger issue TITLE BODY       Create an issue as admin.
 *   trigger comment ISSUE# BODY    Post a comment on an issue.
 *   trigger assign ISSUE# USER     Assign a user to an issue.
 *   trigger label ISSUE# LABEL     Apply a label to an issue.
 *   trigger push-pr BRANCH FILE CONTENT [AUTHOR]
 *                                  Push a branch authored by AUTHOR (default: contributor)
 *                                  and open a PR. Use a non-admin author so Gitea doesn't
 *                                  block self-REQUEST_CHANGES reviews.
 *   watch [RUN_ID|latest]          Poll a workflow run until terminal. Exits 0 on success,
 *                                  nonzero on failure/cancelled/skipped (chainable in shell).
 *
 * Overrides via env vars (defaults in DEFAULTS below):
 *   GITEA_HTTP_PORT, GITEA_SSH_PORT
 *   ADMIN_USER, ADMIN_PASSWORD, CLAUDE_USER, CLAUDE_PASSWORD, CONTRIBUTOR_USER, ...
 *   TEST_REPO, ACTION_REPO, ACTION_BRANCH
 */

import { $ } from "bun";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  rmSync,
} from "fs";
import { resolve, dirname } from "path";

const HERE = dirname(new URL(import.meta.url).pathname);

const DEFAULTS = {
  GITEA_HTTP_PORT: "3030",
  GITEA_SSH_PORT: "2222",
  ADMIN_USER: "admin",
  ADMIN_PASSWORD: "admin123!",
  CLAUDE_USER: "claude",
  CLAUDE_PASSWORD: "claude123456",
  // `contributor` simulates a non-admin developer who opens PRs against
  // the test repo. It is NOT a bot — `claude` is the sole bot identity.
  // Historical name was `claude-bot`, which misled readers into thinking
  // two bots existed.
  CONTRIBUTOR_USER: "contributor",
  CONTRIBUTOR_PASSWORD: "contrib123",
  BOB_USER: "bob",
  BOB_PASSWORD: "bob123456",
  TEST_REPO: "e2e-dummy",
  ACTION_REPO: "claude-code-action",
  ACTION_BRANCH: "gitea",
  TRIGGER_PHRASE: "@claude",
  ASSIGNEE_TRIGGER: "@claude",
  LABEL_TRIGGER: "claude-task",
  ALLOWED_NON_WRITE_USERS: "bob",
} as const;

type ConfigKey = keyof typeof DEFAULTS;
const cfg = Object.fromEntries(
  Object.entries(DEFAULTS).map(([k, v]) => [k, process.env[k] ?? v]),
) as Record<ConfigKey, string>;

const GITEA_BASE = `http://127.0.0.1:${cfg.GITEA_HTTP_PORT}`;
const GITEA_INTERNAL = "http://gitea:3000";

const TOKEN_PATHS = {
  admin: resolve(HERE, ".admin-token"),
  claude: resolve(HERE, ".claude-pat"),
  contributor: resolve(HERE, ".contributor-token"),
  runner: resolve(HERE, ".runner-token"),
};
const ENV_RUNTIME = resolve(HERE, ".env.runtime");
const WORKSPACE = resolve(HERE, "test-repo-workspace");

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function die(msg: string, exitCode = 1): never {
  console.error(`error: ${msg}`);
  process.exit(exitCode);
}

async function giteaFetch<T = unknown>(
  path: string,
  opts: {
    method?: string;
    auth?: { user: string; password: string } | { token: string };
    body?: unknown;
    acceptStatuses?: number[];
    raw?: boolean;
  } = {},
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.auth && "token" in opts.auth) {
    headers["Authorization"] = `token ${opts.auth.token}`;
  } else if (opts.auth) {
    headers["Authorization"] =
      "Basic " + btoa(`${opts.auth.user}:${opts.auth.password}`);
  }
  const res = await fetch(`${GITEA_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const accept = opts.acceptStatuses ?? [200, 201, 204];
  if (!accept.includes(res.status) && !opts.raw) {
    const text = await res.text();
    die(`Gitea ${opts.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return { status: res.status, data: undefined as T };
  const text = await res.text();
  const data = text ? (JSON.parse(text) as T) : (undefined as T);
  return { status: res.status, data };
}

function readToken(which: keyof typeof TOKEN_PATHS): string {
  const p = TOKEN_PATHS[which];
  if (!existsSync(p)) die(`Missing token file: ${p}. Run 'up' first.`, 2);
  return readFileSync(p, "utf8").trim();
}

function saveToken(which: keyof typeof TOKEN_PATHS, value: string) {
  writeFileSync(TOKEN_PATHS[which], value + "\n", { mode: 0o600 });
}

function adminAuth() {
  return { token: readToken("admin") };
}

async function waitForGitea(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${GITEA_BASE}/api/v1/version`);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(1000);
  }
  die("Timed out waiting for Gitea to come up.");
}

async function ensureUser(
  username: string,
  password: string,
  opts: { admin?: boolean } = {},
) {
  const res =
    await $`docker exec -u git gitea-e2e gitea admin user create --username ${username} --password ${password} --email ${username}@localhost --must-change-password=false ${opts.admin ? "--admin" : ""}`
      .nothrow()
      .quiet();
  const out =
    new TextDecoder().decode(res.stdout) + new TextDecoder().decode(res.stderr);
  if (res.exitCode !== 0 && !/already exists/i.test(out)) {
    die(`Failed to create user ${username}: ${out}`);
  }
  if (/already exists/i.test(out)) {
    console.log(`  user ${username}: already exists`);
  } else {
    console.log(`  user ${username}: created`);
  }
}

async function mintToken(
  username: string,
  password: string,
  name: string,
): Promise<string> {
  // Gitea returns 400 (not 422) with message "access token name has been used
  // already" on a duplicate name. Accept both statuses + 201 as the success;
  // fall through to a delete-and-retry path on either collision status.
  const res = await giteaFetch<{ sha1: string; message?: string }>(
    `/api/v1/users/${username}/tokens`,
    {
      method: "POST",
      auth: { user: username, password },
      body: { name, scopes: ["all"] },
      acceptStatuses: [201, 400, 422],
      raw: true,
    },
  );
  if (res.status === 201 && res.data.sha1) return res.data.sha1;

  // Collision path: list existing tokens, delete the one we want to mint,
  // re-create. Gitea never returns the raw sha1 again once minted, so stale
  // tokens can't be recovered — we must delete + re-mint.
  const list = await giteaFetch<Array<{ id: number; name: string }>>(
    `/api/v1/users/${username}/tokens`,
    { auth: { user: username, password } },
  );
  const existing = list.data.find((t) => t.name === name);
  if (existing) {
    await giteaFetch(`/api/v1/users/${username}/tokens/${existing.id}`, {
      method: "DELETE",
      auth: { user: username, password },
    });
  }
  const retry = await giteaFetch<{ sha1: string }>(
    `/api/v1/users/${username}/tokens`,
    {
      method: "POST",
      auth: { user: username, password },
      body: { name, scopes: ["all"] },
      acceptStatuses: [201],
    },
  );
  if (!retry.data.sha1) {
    die(
      `mintToken retry for ${username}/${name} returned no sha1: ${JSON.stringify(retry.data)}`,
    );
  }
  return retry.data.sha1;
}

async function ensureRepo(
  owner: string,
  name: string,
  opts: { autoInit?: boolean; defaultBranch?: string } = {},
) {
  const exists = await giteaFetch(`/api/v1/repos/${owner}/${name}`, {
    auth: adminAuth(),
    acceptStatuses: [200, 404],
    raw: true,
  });
  if (exists.status === 200) {
    console.log(`  repo ${owner}/${name}: already exists`);
    return;
  }
  await giteaFetch(`/api/v1/user/repos`, {
    method: "POST",
    auth: adminAuth(),
    body: {
      name,
      auto_init: opts.autoInit ?? false,
      default_branch: opts.defaultBranch ?? "main",
      private: false,
    },
  });
  console.log(`  repo ${owner}/${name}: created`);
}

async function setDefaultBranch(owner: string, repo: string, branch: string) {
  await giteaFetch(`/api/v1/repos/${owner}/${repo}`, {
    method: "PATCH",
    auth: adminAuth(),
    body: { default_branch: branch },
  });
}

async function addCollaborator(
  owner: string,
  repo: string,
  username: string,
  permission: "read" | "write" | "admin" = "write",
) {
  await giteaFetch(`/api/v1/repos/${owner}/${repo}/collaborators/${username}`, {
    method: "PUT",
    auth: adminAuth(),
    body: { permission },
    acceptStatuses: [204, 422],
  });
  console.log(`  collaborator ${username} → ${owner}/${repo} (${permission})`);
}

async function ensureLabel(
  owner: string,
  repo: string,
  name: string,
  color = "#f29513",
) {
  const list = await giteaFetch<Array<{ name: string }>>(
    `/api/v1/repos/${owner}/${repo}/labels`,
    { auth: adminAuth() },
  );
  if (list.data.some((l) => l.name === name)) return;
  await giteaFetch(`/api/v1/repos/${owner}/${repo}/labels`, {
    method: "POST",
    auth: adminAuth(),
    body: { name, color, description: "E2E trigger label" },
  });
}

function readSecretFromStdin(prompt: string): Promise<string> {
  return new Promise((resolveP) => {
    process.stderr.write(prompt);
    // If stdin is a TTY, switch off echo; otherwise just read
    const isTty = process.stdin.isTTY;
    if (isTty) {
      process.stdin.setRawMode?.(true);
    }
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string | Buffer) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\n" || ch === "\r") {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stderr.write("\n");
          resolveP(buf);
          return;
        }
        if (ch === "\x7f") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    });
  });
}

// --------------------------------------------------------------------------
// Subcommands
// --------------------------------------------------------------------------

async function up() {
  console.log("== up ==");
  console.log("[1/8] starting Gitea container");
  await $`docker compose -f ${HERE}/docker-compose.yml up -d gitea`
    .cwd(HERE)
    .quiet();
  await waitForGitea();

  console.log("[2/8] creating admin + minting admin PAT");
  await ensureUser(cfg.ADMIN_USER, cfg.ADMIN_PASSWORD, { admin: true });
  const adminPat = await mintToken(
    cfg.ADMIN_USER,
    cfg.ADMIN_PASSWORD,
    "e2e-harness",
  );
  saveToken("admin", adminPat);

  console.log("[3/8] generating runner registration token + starting runner");
  const runnerTokenRes =
    await $`docker exec -u git gitea-e2e gitea actions generate-runner-token`.quiet();
  const runnerToken = new TextDecoder().decode(runnerTokenRes.stdout).trim();
  saveToken("runner", runnerToken);
  writeFileSync(
    ENV_RUNTIME,
    `GITEA_RUNNER_REGISTRATION_TOKEN=${runnerToken}\n`,
  );
  // Compose reads .env from the project dir by default; our runtime file is
  // named differently so multiple harnesses could coexist. Copy to .env.
  writeFileSync(
    resolve(HERE, ".env"),
    `GITEA_RUNNER_REGISTRATION_TOKEN=${runnerToken}\n`,
  );
  await $`docker compose -f ${HERE}/docker-compose.yml up -d runner`
    .cwd(HERE)
    .quiet();
  // Wait for registration
  for (let i = 0; i < 30; i++) {
    const logs = new TextDecoder().decode(
      (await $`docker logs gitea-runner-e2e`.quiet().nothrow()).stdout,
    );
    if (/declare successfully|runner.*registered successfully/i.test(logs))
      break;
    await Bun.sleep(1000);
  }
  console.log("  runner: registered");

  console.log("[4/8] creating bot users");
  await ensureUser(cfg.CLAUDE_USER, cfg.CLAUDE_PASSWORD);
  await ensureUser(cfg.CONTRIBUTOR_USER, cfg.CONTRIBUTOR_PASSWORD);
  await ensureUser(cfg.BOB_USER, cfg.BOB_PASSWORD);

  console.log("[5/8] creating test repo + action mirror repo");
  await ensureRepo(cfg.ADMIN_USER, cfg.TEST_REPO, {
    autoInit: true,
    defaultBranch: "main",
  });
  await ensureRepo(cfg.ADMIN_USER, cfg.ACTION_REPO, {
    autoInit: false,
    defaultBranch: cfg.ACTION_BRANCH,
  });

  // Push current repo's ACTION_BRANCH to the mirror (origin of this repo is
  // the parent dir of scripts/e2e-gitea).
  const repoRoot = resolve(HERE, "..", "..");
  console.log(`[6/8] mirroring ${cfg.ACTION_BRANCH} branch to Gitea`);
  const pushUrl = `http://${cfg.ADMIN_USER}:${adminPat}@127.0.0.1:${cfg.GITEA_HTTP_PORT}/${cfg.ADMIN_USER}/${cfg.ACTION_REPO}.git`;
  await $`git push --force ${pushUrl} ${cfg.ACTION_BRANCH}:${cfg.ACTION_BRANCH}`
    .cwd(repoRoot)
    .quiet();
  await setDefaultBranch(cfg.ADMIN_USER, cfg.ACTION_REPO, cfg.ACTION_BRANCH);

  console.log("[7/8] collaborators + claude PAT + contributor PAT");
  await addCollaborator(
    cfg.ADMIN_USER,
    cfg.TEST_REPO,
    cfg.CLAUDE_USER,
    "write",
  );
  await addCollaborator(
    cfg.ADMIN_USER,
    cfg.TEST_REPO,
    cfg.CONTRIBUTOR_USER,
    "write",
  );
  const claudePat = await mintToken(
    cfg.CLAUDE_USER,
    cfg.CLAUDE_PASSWORD,
    "e2e-harness",
  );
  saveToken("claude", claudePat);
  const contributorPat = await mintToken(
    cfg.CONTRIBUTOR_USER,
    cfg.CONTRIBUTOR_PASSWORD,
    "e2e-harness",
  );
  saveToken("contributor", contributorPat);
  await ensureLabel(cfg.ADMIN_USER, cfg.TEST_REPO, cfg.LABEL_TRIGGER);

  // Get claude's numeric user ID for bot_id input
  const claudeInfo = await giteaFetch<{ id: number }>(
    `/api/v1/users/${cfg.CLAUDE_USER}`,
    { auth: adminAuth() },
  );
  const botId = String(claudeInfo.data.id);

  console.log("[8/8] installing workflow + setting CLAUDE_PAT secret");
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  const cloneUrl = `http://${cfg.ADMIN_USER}:${adminPat}@127.0.0.1:${cfg.GITEA_HTTP_PORT}/${cfg.ADMIN_USER}/${cfg.TEST_REPO}.git`;
  await $`git clone ${cloneUrl} ${WORKSPACE}`.quiet();
  await $`git config user.email "${cfg.ADMIN_USER}@localhost"`
    .cwd(WORKSPACE)
    .quiet();
  await $`git config user.name ${cfg.ADMIN_USER}`.cwd(WORKSPACE).quiet();

  const wfTemplate = readFileSync(
    resolve(HERE, "workflow-template.yml"),
    "utf8",
  );
  const wf = wfTemplate
    .replace(
      /\$\{ACTION_USES\}/g,
      `${GITEA_INTERNAL}/${cfg.ADMIN_USER}/${cfg.ACTION_REPO}@${cfg.ACTION_BRANCH}`,
    )
    .replace(/\$\{TRIGGER_PHRASE\}/g, cfg.TRIGGER_PHRASE)
    .replace(/\$\{ASSIGNEE_TRIGGER\}/g, cfg.ASSIGNEE_TRIGGER)
    .replace(/\$\{LABEL_TRIGGER\}/g, cfg.LABEL_TRIGGER)
    .replace(/\$\{ALLOWED_NON_WRITE_USERS\}/g, cfg.ALLOWED_NON_WRITE_USERS)
    .replace(/\$\{BOT_ID\}/g, botId)
    .replace(/\$\{BOT_NAME\}/g, cfg.CLAUDE_USER);
  mkdirSync(resolve(WORKSPACE, ".gitea/workflows"), { recursive: true });
  writeFileSync(resolve(WORKSPACE, ".gitea/workflows/claude.yml"), wf);
  await $`git add .gitea`.cwd(WORKSPACE).quiet();
  await $`git commit -m "ci: install e2e claude workflow"`
    .cwd(WORKSPACE)
    .nothrow()
    .quiet();
  await $`git push`.cwd(WORKSPACE).quiet();

  // Set CLAUDE_PAT secret (used by the workflow as gitea_token).
  await giteaFetch(
    `/api/v1/repos/${cfg.ADMIN_USER}/${cfg.TEST_REPO}/actions/secrets/CLAUDE_PAT`,
    {
      method: "PUT",
      auth: adminAuth(),
      body: { data: claudePat },
    },
  );

  console.log("");
  console.log("✓ up complete");
  console.log(`  Gitea UI:      ${GITEA_BASE}`);
  console.log(`  admin login:   ${cfg.ADMIN_USER} / ${cfg.ADMIN_PASSWORD}`);
  console.log(`  claude login:  ${cfg.CLAUDE_USER} / ${cfg.CLAUDE_PASSWORD}`);
  console.log(
    `  test repo:     ${GITEA_BASE}/${cfg.ADMIN_USER}/${cfg.TEST_REPO}`,
  );
  console.log(
    `  action mirror: ${GITEA_BASE}/${cfg.ADMIN_USER}/${cfg.ACTION_REPO}`,
  );
  console.log("");
  console.log("Next:");
  console.log(
    `  echo 'sk-ant-oat01-...' | bun ${HERE}/e2e.ts secret CLAUDE_CODE_OAUTH_TOKEN`,
  );
  console.log(
    `  bun ${HERE}/e2e.ts trigger issue "smoke" "@claude hello" && bun ${HERE}/e2e.ts watch`,
  );
}

async function down() {
  console.log("== down ==");
  await $`docker compose -f ${HERE}/docker-compose.yml down -v`
    .cwd(HERE)
    .nothrow()
    .quiet();
  for (const p of Object.values(TOKEN_PATHS)) {
    if (existsSync(p)) unlinkSync(p);
  }
  // Best-effort cleanup of legacy token files from before the
  // claude-bot → contributor rename. Safe no-op on fresh checkouts.
  for (const legacy of [".bob-token"]) {
    const p = resolve(HERE, legacy);
    if (existsSync(p)) unlinkSync(p);
  }
  for (const f of [ENV_RUNTIME, resolve(HERE, ".env")]) {
    if (existsSync(f)) unlinkSync(f);
  }
  for (const d of ["gitea-data", "runner-data", "test-repo-workspace"]) {
    rmSync(resolve(HERE, d), { recursive: true, force: true });
  }
  console.log("✓ torn down");
}

async function status() {
  console.log("== status ==");
  const ps =
    await $`docker ps --filter name=gitea-e2e --filter name=gitea-runner-e2e --format "{{.Names}}\t{{.Status}}"`
      .quiet()
      .nothrow();
  console.log("containers:");
  console.log(new TextDecoder().decode(ps.stdout).trimEnd() || "  (none)");
  if (!existsSync(TOKEN_PATHS.admin)) {
    console.log("(stack not initialized — run 'up')");
    return;
  }
  const runs = await giteaFetch<{
    workflow_runs: Array<{
      id: number;
      status: string;
      event: string;
      head_branch: string;
    }>;
  }>(`/api/v1/repos/${cfg.ADMIN_USER}/${cfg.TEST_REPO}/actions/tasks`, {
    auth: adminAuth(),
  });
  console.log("\nlatest runs (most recent 5):");
  for (const r of runs.data.workflow_runs.slice(0, 5)) {
    console.log(
      `  #${r.id} ${r.status} event=${r.event} branch=${r.head_branch}`,
    );
  }
  const prs = await giteaFetch<
    Array<{ number: number; title: string; state: string }>
  >(`/api/v1/repos/${cfg.ADMIN_USER}/${cfg.TEST_REPO}/pulls?state=open`, {
    auth: adminAuth(),
  });
  console.log("\nopen PRs:");
  if (prs.data.length === 0) console.log("  (none)");
  else for (const p of prs.data) console.log(`  #${p.number} ${p.title}`);
}

async function setSecret(name: string) {
  if (!name) die("Usage: secret NAME");
  const value = await readSecretFromStdin(`${name} value (hidden): `);
  if (!value) die("empty secret, aborting");
  const res = await giteaFetch(
    `/api/v1/repos/${cfg.ADMIN_USER}/${cfg.TEST_REPO}/actions/secrets/${name}`,
    {
      method: "PUT",
      auth: adminAuth(),
      body: { data: value },
    },
  );
  console.log(`✓ secret ${name} set (status ${res.status})`);
}

async function trigger(args: string[]) {
  const [sub, ...rest] = args;
  if (!sub) die("Usage: trigger <issue|comment|assign|label|push-pr> ...");
  switch (sub) {
    case "issue": {
      const [title, body] = rest;
      if (!title || !body) die("trigger issue TITLE BODY");
      const res = await giteaFetch<{ number: number }>(
        `/api/v1/repos/${cfg.ADMIN_USER}/${cfg.TEST_REPO}/issues`,
        {
          method: "POST",
          auth: adminAuth(),
          body: { title, body },
        },
      );
      console.log(res.data.number);
      return;
    }
    case "comment": {
      const [num, body] = rest;
      if (!num || !body) die("trigger comment ISSUE# BODY");
      const res = await giteaFetch<{ id: number }>(
        `/api/v1/repos/${cfg.ADMIN_USER}/${cfg.TEST_REPO}/issues/${num}/comments`,
        {
          method: "POST",
          auth: adminAuth(),
          body: { body },
        },
      );
      console.log(res.data.id);
      return;
    }
    case "assign": {
      const [num, user] = rest;
      if (!num || !user) die("trigger assign ISSUE# USER");
      await giteaFetch(
        `/api/v1/repos/${cfg.ADMIN_USER}/${cfg.TEST_REPO}/issues/${num}`,
        {
          method: "PATCH",
          auth: adminAuth(),
          body: { assignees: [user] },
        },
      );
      console.log(`assigned ${user}`);
      return;
    }
    case "label": {
      const [num, label] = rest;
      if (!num || !label) die("trigger label ISSUE# LABEL");
      await giteaFetch(
        `/api/v1/repos/${cfg.ADMIN_USER}/${cfg.TEST_REPO}/issues/${num}/labels`,
        {
          method: "POST",
          auth: adminAuth(),
          body: { labels: [label] },
        },
      );
      console.log(`labeled ${label}`);
      return;
    }
    case "push-pr": {
      const [branch, file, content, authorArg] = rest;
      const author = authorArg ?? cfg.CONTRIBUTOR_USER;
      if (!branch || !file || content === undefined)
        die("trigger push-pr BRANCH FILE CONTENT [AUTHOR]");
      const authorToken =
        author === cfg.ADMIN_USER
          ? readToken("admin")
          : author === cfg.CLAUDE_USER
            ? readToken("claude")
            : readToken("contributor");
      const authorEmail = `${author}@localhost`;
      const wsDir = resolve(HERE, `pr-workspace-${Date.now()}`);
      const cloneUrl = `http://${author}:${authorToken}@127.0.0.1:${cfg.GITEA_HTTP_PORT}/${cfg.ADMIN_USER}/${cfg.TEST_REPO}.git`;
      await $`git clone ${cloneUrl} ${wsDir}`.quiet();
      await $`git config user.email ${authorEmail}`.cwd(wsDir).quiet();
      await $`git config user.name ${author}`.cwd(wsDir).quiet();
      await $`git checkout -b ${branch}`.cwd(wsDir).quiet();
      writeFileSync(resolve(wsDir, file), content);
      await $`git add ${file}`.cwd(wsDir).quiet();
      await $`git commit -m "add ${file} (by ${author})"`.cwd(wsDir).quiet();
      await $`git push -u origin ${branch}`.cwd(wsDir).quiet();
      rmSync(wsDir, { recursive: true, force: true });
      const res = await giteaFetch<{ number: number }>(
        `/api/v1/repos/${cfg.ADMIN_USER}/${cfg.TEST_REPO}/pulls`,
        {
          method: "POST",
          auth: { user: author, password: authorToken },
          body: {
            title: `PR from ${author}: ${branch}`,
            head: branch,
            base: "main",
            body: `Opened via e2e.ts push-pr by ${author}.`,
          },
        },
      );
      console.log(res.data.number);
      return;
    }
    default:
      die(`unknown trigger subcommand: ${sub}`);
  }
}

async function watch(args: string[]) {
  const which = args[0] ?? "latest";
  let runId: number | undefined;
  if (which !== "latest") runId = parseInt(which, 10);
  const deadline = Date.now() + 10 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const runs = await giteaFetch<{
      workflow_runs: Array<{ id: number; status: string; event: string }>;
    }>(`/api/v1/repos/${cfg.ADMIN_USER}/${cfg.TEST_REPO}/actions/tasks`, {
      auth: adminAuth(),
    });
    const target =
      runId !== undefined
        ? runs.data.workflow_runs.find((r) => r.id === runId)
        : runs.data.workflow_runs[0];
    if (!target) {
      await Bun.sleep(3000);
      continue;
    }
    const line = `run #${target.id} status=${target.status} event=${target.event}`;
    if (line !== last) {
      console.log(line);
      last = line;
    }
    if (
      ["success", "failure", "cancelled", "skipped"].includes(target.status)
    ) {
      console.log(
        `logs: ${GITEA_BASE}/${cfg.ADMIN_USER}/${cfg.TEST_REPO}/actions/runs/${target.id}`,
      );
      process.exit(target.status === "success" ? 0 : 1);
    }
    await Bun.sleep(4000);
  }
  die("watch: timeout after 10 minutes");
}

// --------------------------------------------------------------------------
// Dispatcher
// --------------------------------------------------------------------------

function helpAndExit(code = 0): never {
  const doc = `Gitea E2E harness.

Usage: bun ${HERE}/e2e.ts <subcommand> [args...]

Subcommands:
  up                             Bring up stack; create users/repos/tokens; install workflow.
  down                           Tear down + wipe data dirs + remove token files.
  status                         Show containers, latest runs, open PRs.
  secret NAME                    Set a repo secret (reads value from stdin).
  trigger issue TITLE BODY       Create an issue as admin. Prints issue number.
  trigger comment ISSUE# BODY    Post a comment on an issue.
  trigger assign ISSUE# USER     Assign a user to an issue.
  trigger label ISSUE# LABEL     Apply a label to an issue.
  trigger push-pr BRANCH FILE CONTENT [AUTHOR]
                                 Push a branch as AUTHOR and open a PR.
                                 Default AUTHOR is ${DEFAULTS.CONTRIBUTOR_USER}.
  watch [RUN_ID|latest]          Poll a run until terminal. 0=success, 1=fail.

Overrides: set env vars matching the keys in DEFAULTS at top of e2e.ts.
`;
  console.log(doc);
  process.exit(code);
}

const [, , sub, ...rest] = process.argv;
if (!sub || sub === "--help" || sub === "-h") helpAndExit();

switch (sub) {
  case "up":
    await up();
    break;
  case "down":
    await down();
    break;
  case "status":
    await status();
    break;
  case "secret":
    await setSecret(rest[0] ?? "");
    break;
  case "trigger":
    await trigger(rest);
    break;
  case "watch":
    await watch(rest);
    break;
  default:
    console.error(`unknown subcommand: ${sub}`);
    helpAndExit(2);
}
