export function collectActionInputsPresence(): string {
  const inputDefaults: Record<string, string> = {
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
    branch_name_template: "",
    allowed_bots: "",
    include_comments_by_actor: "",
    exclude_comments_by_actor: "",
    prompt: "",
    github_token: "",
    use_sticky_comment: "false",
    use_commit_signing: "false",
    ssh_signing_key: "",
    bot_id: "",
    bot_name: "",
    track_progress: "false",
    path_to_bun_executable: "",
    display_report: "false",
    show_full_output: "false",
    buffer_inline_comments: "true",
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
