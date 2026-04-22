import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runClaude } from "../src/run-claude";

// runClaude injects claude_env KEY: value pairs into process.env before
// handing off to the SDK. We only exercise the env-injection side-effect
// here; the SDK call itself is not invoked in this suite.

const RESERVED = new Set(["PATH", "HOME", "RUNNER_TEMP", "GITHUB_ACTION_PATH"]);

function snapshotEnv() {
  return { ...process.env };
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const k of Object.keys(process.env)) {
    if (!(k in snapshot) && !RESERVED.has(k)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("runClaude: claude_env parsing", () => {
  let original: ReturnType<typeof snapshotEnv>;

  beforeEach(() => {
    original = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(original);
  });

  test("injects KEY: value pairs into process.env", async () => {
    delete process.env.MY_FLAG;
    delete process.env.OTHER;
    // We expect runClaude to set the env vars before calling into the SDK.
    // The SDK call will fail (no real prompt file), but the env mutation
    // happens synchronously before that.
    await runClaude("/does/not/exist", {
      claudeEnv: "MY_FLAG: on\nOTHER: value with spaces",
    }).catch(() => {});

    expect(process.env.MY_FLAG).toBe("on");
    expect(process.env.OTHER).toBe("value with spaces");
  });

  test("ignores comments and blank lines", async () => {
    delete process.env.KEEP;
    await runClaude("/does/not/exist", {
      claudeEnv: "# leading comment\n\nKEEP: kept\n  # indented comment\n",
    }).catch(() => {});

    expect(process.env.KEEP).toBe("kept");
  });

  test("no-ops when claude_env is empty or unset", async () => {
    const before = process.env.SHOULD_NOT_SET;
    await runClaude("/does/not/exist", { claudeEnv: "" }).catch(() => {});
    await runClaude("/does/not/exist", { claudeEnv: undefined }).catch(
      () => {},
    );

    expect(process.env.SHOULD_NOT_SET).toBe(before);
  });
});
