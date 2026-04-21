import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as core from "@actions/core";
import { setupGitHubToken } from "../src/github/token";

describe("setupGitHubToken (Gitea-compatible auth)", () => {
  const originalEnv = process.env;
  let setOutputSpy: ReturnType<typeof spyOn<typeof core, "setOutput">>;
  let setFailedSpy: ReturnType<typeof spyOn<typeof core, "setFailed">>;
  let exitSpy: ReturnType<typeof spyOn<typeof process, "exit">>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OVERRIDE_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    setFailedSpy = spyOn(core, "setFailed").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    process.env = originalEnv;
    setOutputSpy.mockRestore();
    setFailedSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prefers OVERRIDE_GITHUB_TOKEN (from gitea_token input) over GITHUB_TOKEN", async () => {
    process.env.OVERRIDE_GITHUB_TOKEN = "gitea-pat-token";
    process.env.GITHUB_TOKEN = "workflow-default-token";

    const token = await setupGitHubToken();

    expect(token).toBe("gitea-pat-token");
    expect(setOutputSpy).toHaveBeenCalledWith(
      "GITHUB_TOKEN",
      "gitea-pat-token",
    );
    expect(setFailedSpy).not.toHaveBeenCalled();
  });

  it("falls back to GITHUB_TOKEN when OVERRIDE_GITHUB_TOKEN is not set", async () => {
    process.env.GITHUB_TOKEN = "workflow-default-token";

    const token = await setupGitHubToken();

    expect(token).toBe("workflow-default-token");
    expect(setOutputSpy).toHaveBeenCalledWith(
      "GITHUB_TOKEN",
      "workflow-default-token",
    );
  });

  it("fails with gitea_token guidance when neither env var is set", async () => {
    await expect(setupGitHubToken()).rejects.toThrow("process.exit called");

    expect(setFailedSpy).toHaveBeenCalledTimes(1);
    const failureMessage = setFailedSpy.mock.calls[0]?.[0] as string;
    expect(failureMessage).toContain("gitea_token");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("ignores empty OVERRIDE_GITHUB_TOKEN and uses GITHUB_TOKEN", async () => {
    process.env.OVERRIDE_GITHUB_TOKEN = "";
    process.env.GITHUB_TOKEN = "workflow-default-token";

    const token = await setupGitHubToken();

    expect(token).toBe("workflow-default-token");
  });
});
