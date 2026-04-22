export function collectActionInputsPresence(): string {
  const inputDefaults: Record<string, string> = {
    trigger_phrase: "@claude",
    assignee_trigger: "",
    label_trigger: "claude",
    base_branch: "",
    branch_prefix: "claude/",
    allowed_bots: "",
    mode: "tag",
    model: "",
    anthropic_model: "",
    fallback_model: "",
    allowed_tools: "",
    disallowed_tools: "",
    custom_instructions: "",
    direct_prompt: "",
    override_prompt: "",
    additional_permissions: "",
    claude_env: "",
    settings: "",
    anthropic_api_key: "",
    claude_code_oauth_token: "",
    github_token: "",
    max_turns: "",
    ssh_signing_key: "",
  };

  // GitHub Actions exposes each input as INPUT_<NAME_IN_UPPER_SNAKE_CASE>
  // automatically. Read them directly — the old path required action.yml
  // to JSON-encode every input into an ALL_INPUTS env var, which it never
  // did, so this function used to always return {} in production runs.
  const presentInputs: Record<string, boolean> = {};
  for (const [name, defaultValue] of Object.entries(inputDefaults)) {
    const envName = `INPUT_${name.replace(/-/g, "_").toUpperCase()}`;
    const actualValue = process.env[envName] ?? "";
    presentInputs[name] = actualValue !== defaultValue;
  }
  return JSON.stringify(presentInputs);
}
