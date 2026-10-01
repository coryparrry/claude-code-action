type Event = Record<string, unknown>;

/** Normalize completed Codex messages for the existing action report formatter. */
export class CodexTranscript {
  readonly messages: Event[] = [];
  sessionId?: string;
  completed = false;
  failed = false;
  finalMessage?: string;
  private readonly startedAt = Date.now();
  private turns = 0;
  private usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
  };

  accept(event: Event): void {
    if (
      event.type === "thread.started" &&
      typeof event.thread_id === "string"
    ) {
      this.sessionId = event.thread_id;
      this.messages.push({
        type: "system",
        subtype: "init",
        session_id: this.sessionId,
        tools: [],
      });
    } else if (event.type === "turn.started") {
      this.turns++;
      this.completed = false;
    } else if (event.type === "turn.completed") {
      this.completed = true;
      const usage = event.usage as Event | undefined;
      if (usage) {
        const tokens = (name: string) =>
          typeof usage[name] === "number" && Number.isFinite(usage[name])
            ? Math.max(0, usage[name] as number)
            : 0;
        const cached = tokens("cached_input_tokens");
        this.usage.input_tokens += Math.max(0, tokens("input_tokens") - cached);
        this.usage.cache_read_input_tokens += cached;
        this.usage.output_tokens += tokens("output_tokens");
      }
    } else if (event.type === "error" || event.type === "turn.failed") {
      this.failed = true;
      this.messages.push({ type: "system", subtype: "codex_error", event });
    } else if (event.type === "item.completed") {
      const item = event.item as Event | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        this.finalMessage = item.text;
        this.addAssistant(item.text);
      } else if (item) {
        this.messages.push({ type: "system", subtype: "codex_item", item });
      }
    }
  }

  addAssistant(text: string): void {
    this.messages.push({
      type: "assistant",
      session_id: this.sessionId ?? "",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  }

  finish(error?: string, structuredOutput?: unknown): void {
    this.messages.push({
      type: "result",
      subtype: error ? "error_during_execution" : "success",
      is_error: !!error,
      session_id: this.sessionId ?? "",
      result: error ?? this.finalMessage ?? "",
      num_turns: this.turns,
      duration_ms: Date.now() - this.startedAt,
      usage: this.usage,
      ...(error ? { errors: [error] } : {}),
      ...(structuredOutput !== undefined
        ? { structured_output: structuredOutput }
        : {}),
    });
  }
}
