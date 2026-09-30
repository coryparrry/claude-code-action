export function collectActionInputsPresence(): string {
  const inputDefaults: Record<string, string> = {
    engine: "codex",
    openai_api_key: "",
    codex_model: "",
    codex_effort: "",
    codex_sandbox: "workspace-write",
    codex_version: "0.159.2",
    path_to_codex_executable: "",
    trigger_phrase: "@codex",
    assignee_trigger: "",
    label_trigger: "codex",
    base_branch: "",
    branch_prefix: "codex/",
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
    anthropic_federation_rule_id: "",
    anthropic_organization_id: "",
    anthropic_service_account_id: "",
    anthropic_workspace_id: "",
    anthropic_oidc_audience: "",
    github_token: "",
    max_turns: "",
    use_sticky_comment: "false",
    classify_inline_comments: "true",
    use_commit_signing: "false",
    ssh_signing_key: "",
  };

  const allInputsJson = process.env.ALL_INPUTS;
  if (!allInputsJson) {
    console.log("ALL_INPUTS environment variable not found");
    return JSON.stringify({});
  }

  let allInputs: Record<string, string>;
  try {
    allInputs = JSON.parse(allInputsJson);
  } catch (e) {
    console.error("Failed to parse ALL_INPUTS JSON:", e);
    return JSON.stringify({});
  }

  const presentInputs: Record<string, boolean> = {};

  for (const [name, defaultValue] of Object.entries(inputDefaults)) {
    const actualValue = allInputs[name] || "";

    const isSet = actualValue !== defaultValue;
    presentInputs[name] = isSet;
  }

  return JSON.stringify(presentInputs);
}
