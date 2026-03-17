import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { CodeMutationTask } from "./types.js";

export type CodeMutationExecution = {
  task: CodeMutationTask;
  status: "planned" | "executed" | "failed" | "skipped";
  detail: string;
};

export type CodeAgent = {
  execute(params: {
    tasks: CodeMutationTask[];
    outputDir: string;
    allowCodeMutation: boolean;
    cwd?: string;
    provider?: string;
    model?: string;
  }): Promise<CodeMutationExecution[]>;
};

type TextResponder = (prompt: string, opts: {
  provider?: string;
  model?: string;
  cwd?: string;
}) => Promise<{ text: string }>;

function getTextResponder(): TextResponder {
  const require = createRequire(import.meta.url);
  const home = process.env.HOME;

  if (!home) {
    throw new Error("HOME is required to resolve ~/git/ucm");
  }

  const imported = require(`${home}/git/ucm/legacy/lib/core/llm.js`) as { llmText?: TextResponder };

  if (typeof imported.llmText !== "function") {
    throw new Error("llmText not found in ucm core llm module");
  }

  return imported.llmText;
}

export class UcmCodeMutationAgent implements CodeAgent {
  private readonly llmText = getTextResponder();

  async execute(params: {
    tasks: CodeMutationTask[];
    outputDir: string;
    allowCodeMutation: boolean;
    cwd?: string;
    provider?: string;
    model?: string;
  }): Promise<CodeMutationExecution[]> {
    await mkdir(params.outputDir, { recursive: true });

    const executions: CodeMutationExecution[] = [];

    for (const [index, task] of params.tasks.entries()) {
      const normalizedTask = {
        ...task,
        taskId: task.taskId ?? `code-task-${String(index + 1).padStart(2, "0")}`
      };

      if (!params.allowCodeMutation) {
        executions.push({
          task: normalizedTask,
          status: "skipped",
          detail: "Code mutation disabled by config."
        });
        continue;
      }

      const prompt = [
        "You are acting as an autonomous coding agent inside the fst repository.",
        "Make the requested code change directly in the repository.",
        "After editing, run the minimum relevant validation commands.",
        "Do not output markdown fences.",
        "",
        `Task: ${normalizedTask.title}`,
        `Intent: ${normalizedTask.intent}`,
        `Rationale: ${normalizedTask.rationale}`,
        `Acceptance criteria: ${normalizedTask.acceptanceCriteria.join("; ") || "none provided"}`,
        `Target files: ${normalizedTask.targetFiles.join(", ") || "not specified"}`,
        "",
        normalizedTask.prompt,
        "",
        "Return a short plain-text summary of what changed and what validation ran."
      ].join("\n");

      try {
        const result = await this.llmText(prompt, {
          provider: params.provider,
          model: params.model,
          cwd: params.cwd ?? process.cwd()
        });
        executions.push({
          task: normalizedTask,
          status: "executed",
          detail: result.text.trim()
        });
      } catch (error) {
        executions.push({
          task: normalizedTask,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error)
        });
      }
    }

    await writeFile(
      path.join(params.outputDir, "code-tasks.json"),
      `${JSON.stringify(executions, null, 2)}\n`
    );

    return executions;
  }
}
