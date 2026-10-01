import { z } from "zod";
import type { Tool } from "@openai/agents";
import type { AgentPermissions } from "./agent-permissions";

type RegisterTool = (
  name: string,
  description: string,
  shape: z.ZodRawShape,
  execute: (input: Record<string, unknown>) => Promise<string>,
) => Tool;
const optionalString = z.string().nullable().optional();

/** Original interaction schemas, with explicit headless approval and answer injection. */
export function createInteractionTools(
  permissions: AgentPermissions,
  register: RegisterTool,
): Tool[] {
  let priorMode =
    permissions.options.permissionMode === "plan"
      ? "default"
      : (permissions.options.permissionMode ?? "default");
  const questionSchema = z.object({
    questions: z
      .array(
        z.object({
          question: z.string(),
          header: z.string().max(12),
          options: z
            .array(
              z.object({
                label: z.string(),
                description: z.string(),
                preview: optionalString,
              }),
            )
            .min(2)
            .max(4),
          multiSelect: z.boolean(),
        }),
      )
      .min(1)
      .max(4),
    answers: z.record(z.string(), z.string()).nullable().optional(),
    annotations: z
      .record(
        z.string(),
        z.object({ preview: optionalString, notes: optionalString }),
      )
      .nullable()
      .optional(),
    metadata: z.object({ source: optionalString }).nullable().optional(),
  });
  const exitSchema = z
    .object({
      allowedPrompts: z
        .array(z.object({ tool: z.literal("Bash"), prompt: z.string() }))
        .nullable()
        .optional(),
      plan: optionalString,
      filePath: optionalString,
    })
    .passthrough();
  return [
    register(
      "EnterPlanMode",
      "Enter read-only planning mode. Editing and shell execution remain blocked until ExitPlanMode is explicitly approved.",
      {},
      async () => {
        if (permissions.options.permissionMode !== "plan")
          priorMode = permissions.options.permissionMode ?? "default";
        permissions.applyUpdates([
          { type: "setMode", mode: "plan", destination: "session" },
        ]);
        return JSON.stringify({
          message:
            "Entered plan mode. Source edits and shell commands require leaving plan mode with explicit approval.",
        });
      },
    ),
    register(
      "ExitPlanMode",
      "Request approval to leave planning mode and restore the earlier permission mode. Headless execution needs an explicit tool rule or hook approval; allowedPrompts is deprecated.",
      exitSchema.shape,
      async (raw) => {
        const input = exitSchema.parse(raw);
        if (permissions.options.permissionMode !== "plan")
          throw new Error("The agent is not in plan mode");
        permissions.applyUpdates([
          { type: "setMode", mode: priorMode, destination: "session" },
        ]);
        return JSON.stringify({
          plan: input.plan ?? null,
          isAgent: false,
          ...(input.filePath ? { filePath: input.filePath } : {}),
        });
      },
    ),
    register(
      "AskUserQuestion",
      "Ask 1–4 questions with 2–4 options each. This action is headless: trusted hooks must inject answers keyed by question text and approve the call.",
      questionSchema.shape,
      async (raw) => {
        const input = questionSchema.parse(raw);
        if (
          !input.answers ||
          input.questions.some(
            (question) =>
              typeof input.answers?.[question.question] !== "string",
          )
        )
          throw new Error(
            "AskUserQuestion requires trusted hook answers for every question; no interactive user interface is available",
          );
        const questions = input.questions.map((question) => ({
          ...question,
          options: question.options.map(({ preview, ...option }) => ({
            ...option,
            ...(preview != null ? { preview } : {}),
          })),
        }));
        const annotations = input.annotations
          ? Object.fromEntries(
              Object.entries(input.annotations).map(
                ([question, annotation]) => [
                  question,
                  Object.fromEntries(
                    Object.entries(annotation).filter(
                      ([, value]) => value != null,
                    ),
                  ),
                ],
              ),
            )
          : undefined;
        return JSON.stringify({
          questions,
          answers: input.answers,
          ...(annotations ? { annotations } : {}),
        });
      },
    ),
  ];
}
