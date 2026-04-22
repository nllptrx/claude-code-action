import { describe, test, expect } from "bun:test";
import { buildClaudeArgs } from "../src/entrypoints/run";

describe("buildClaudeArgs", () => {
  test("embeds mcp config as --mcp-config flag", () => {
    const mcpConfig = JSON.stringify({
      mcpServers: { gitea: { command: "bun", args: [] } },
    });

    const result = buildClaudeArgs(mcpConfig, undefined);

    // Must start with --mcp-config so parseSdkOptions picks it up from
    // extraArgs (it ignores options.mcpConfig).
    expect(result.startsWith("--mcp-config ")).toBe(true);
    expect(result).toContain(mcpConfig);
  });

  test("single-quote in mcp config is escaped for shell", () => {
    const mcpConfig = `{"description":"don't"}`;

    const result = buildClaudeArgs(mcpConfig, undefined);

    expect(result).toBe(`--mcp-config '{"description":"don'\\''t"}'`);
  });

  test("appends user-supplied claude_args after the generated flag", () => {
    const mcpConfig = JSON.stringify({ mcpServers: {} });

    const result = buildClaudeArgs(mcpConfig, "--max-turns 5 --model sonnet");

    expect(result).toMatch(/^--mcp-config '.*' --max-turns 5 --model sonnet$/);
  });

  test("user claude_args with --mcp-config is preserved so parseSdkOptions can merge", () => {
    const ourConfig = JSON.stringify({
      mcpServers: { gitea: { command: "bun" } },
    });
    const userConfig = `--mcp-config '{"mcpServers":{"user":{"command":"npx"}}}'`;

    const result = buildClaudeArgs(ourConfig, userConfig);

    // Both --mcp-config occurrences must survive; parseSdkOptions merges them.
    const mcpConfigCount = (result.match(/--mcp-config /g) || []).length;
    expect(mcpConfigCount).toBe(2);
  });

  test("empty userClaudeArgs does not leave trailing whitespace", () => {
    const mcpConfig = "{}";

    expect(buildClaudeArgs(mcpConfig, "")).toBe("--mcp-config '{}'");
    expect(buildClaudeArgs(mcpConfig, "   ")).toBe("--mcp-config '{}'");
    expect(buildClaudeArgs(mcpConfig, undefined)).toBe("--mcp-config '{}'");
  });
});
