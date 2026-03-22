import { spawn } from "node:child_process";

const RATE_LIMIT_RE = /rate.limit|429|quota|overloaded/i;
const REASONING_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
]);
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 5_000;

const ENV_ALLOWED_EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "HOSTNAME",
  "LOGNAME",
  "EDITOR",
  "VISUAL",
  "DISPLAY",
  "TMPDIR",
  "TMP",
  "TEMP",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "JAVA_HOME",
  "ANDROID_HOME",
  "VIRTUAL_ENV",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY"
]);

const ENV_ALLOWED_PREFIXES = [
  "LC_",
  "NODE_",
  "NPM_",
  "NVM_",
  "GIT_",
  "XDG_",
  "SSH_",
  "GPG_",
  "CONDA_",
  "PYENV_",
  "DBUS_",
  "GEMINI_",
  "GOOGLE_",
  "FST_"
];

export type CliLlmProvider = "claude" | "codex" | "gemini";
export type CliOutputFormat = "text" | "json" | "stream-json";

export type CliLlmOptions = {
  provider?: string;
  model?: string;
  cwd?: string;
  configOverrides?: string[];
  outputFormat?: CliOutputFormat;
  allowTools?: string;
  skipPermissions?: boolean;
  sessionPersistence?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  hardTimeoutMs?: number;
  extraEnv?: Record<string, string>;
  onData?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

type Command = {
  cmd: string;
  args: string[];
  cwd?: string;
};

type SpawnLlmResult = {
  status: "done" | "timeout" | "failed" | "rate_limited";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timeoutKind: "single" | "idle" | "hard" | null;
  durationMs: number;
  tokenUsage?: {
    input: number;
    output: number;
  };
};

function normalizeCodexModel(model: string | undefined): string | null | undefined {
  if (typeof model !== "string") {
    return model;
  }

  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (REASONING_EFFORTS.has(normalized)) {
    return normalized;
  }

  if (normalized.includes("haiku")) {
    return "low";
  }

  if (normalized.includes("sonnet")) {
    return "medium";
  }

  if (normalized.includes("opus")) {
    return "high";
  }

  return model;
}

const GEMINI_NATIVE_MODELS = new Set(["auto", "pro", "flash", "flash-lite"]);

function normalizeGeminiModel(model: string | undefined): string | null | undefined {
  if (typeof model !== "string") {
    return model;
  }

  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (GEMINI_NATIVE_MODELS.has(normalized) || normalized.startsWith("gemini-")) {
    return normalized;
  }

  if (normalized.includes("haiku") || normalized.includes("sonnet")) {
    return "flash";
  }

  if (normalized.includes("opus")) {
    return "pro";
  }

  return model;
}

export function sanitizeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (
      typeof value === "string" &&
      (
        ENV_ALLOWED_EXACT.has(key) ||
        ENV_ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))
      )
    ) {
      env[key] = value;
    }
  }

  return env;
}

export function killPidTree(pid: number | undefined): void {
  if (!pid || pid <= 0) {
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      console.error(`[killPidTree] SIGTERM pgid ${pid}: ${(error as Error).message}`);
    }
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      console.error(`[killPidTree] SIGTERM pid ${pid}: ${(error as Error).message}`);
    }
  }

  const fallback = setTimeout(() => {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }

    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error(`[killPidTree] SIGKILL pgid ${pid}: ${(error as Error).message}`);
      }
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        console.error(`[killPidTree] SIGKILL pid ${pid}: ${(error as Error).message}`);
      }
    }
  }, 1_200);
  fallback.unref();
}

export function buildCommand(options: CliLlmOptions = {}): Command {
  const provider = options.provider ?? process.env.FST_LLM_PROVIDER ?? "codex";

  if (provider === "claude") {
    const args = ["-p"];
    if (options.skipPermissions ?? true) {
      args.push("--dangerously-skip-permissions");
    }
    if (!(options.sessionPersistence ?? false)) {
      args.push("--no-session-persistence");
    }
    const format = options.outputFormat ?? "text";
    args.push("--output-format", format);
    if (format === "stream-json") {
      args.push("--verbose");
    }
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.allowTools !== undefined) {
      args.push("--allowedTools", options.allowTools);
    }
    return { cmd: "claude", args, cwd: options.cwd };
  }

  if (provider === "codex") {
    const args = [
      "exec",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox"
    ];
    const format = options.outputFormat ?? "text";
    if (format === "json" || format === "stream-json") {
      args.push("--json");
    }
    const normalizedModel = normalizeCodexModel(options.model);
    for (const override of options.configOverrides ?? []) {
      if (override.trim()) {
        args.push("-c", override.trim());
      }
    }
    if (normalizedModel && REASONING_EFFORTS.has(normalizedModel)) {
      args.push("-c", `model_reasoning_effort=${normalizedModel}`);
    } else if (normalizedModel) {
      args.push("--model", normalizedModel);
    }
    if (options.cwd) {
      args.push("--cd", options.cwd);
    }
    args.push("-");
    return { cmd: "codex", args, cwd: options.cwd };
  }

  if (provider === "gemini") {
    const args: string[] = [];
    if (options.skipPermissions ?? true) {
      args.push("-y");
    }
    const format = options.outputFormat ?? "text";
    args.push("--output-format", format);
    const normalizedModel = normalizeGeminiModel(options.model);
    if (normalizedModel) {
      args.push("--model", normalizedModel);
    }
    return { cmd: "gemini", args, cwd: options.cwd };
  }

  throw new Error(`unknown provider: ${provider}`);
}

export function extractJson(text: string): unknown {
  const codeBlock = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (codeBlock) {
    try {
      return JSON.parse(codeBlock[1]);
    } catch {}
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {}
  }

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(text.slice(arrayStart, arrayEnd + 1));
    } catch {}
  }

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      return JSON.parse(text.slice(objectStart, objectEnd + 1));
    } catch {}
  }

  const preview = text.length > 300 ? `${text.slice(0, 300)}...` : text;
  throw new Error(`Failed to extract JSON from LLM response: ${preview}`);
}

export async function spawnLlm(prompt: string, options: CliLlmOptions = {}): Promise<SpawnLlmResult> {
  const { cmd, args, cwd } = buildCommand(options);
  const startTime = Date.now();
  const env = {
    ...sanitizeEnv(),
    ...options.extraEnv
  };

  const child = spawn(cmd, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    detached: true
  });

  let stdout = "";
  let stderr = "";
  let timeoutKind: SpawnLlmResult["timeoutKind"] = null;
  let killed = false;

  let stdoutBuffer = "";
  let resultText = "";
  const tokenUsage = { input: 0, output: 0 };

  let singleTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;

  const killChild = (kind: NonNullable<SpawnLlmResult["timeoutKind"]>) => {
    if (killed) {
      return;
    }
    killed = true;
    timeoutKind = kind;
    killPidTree(child.pid);
  };

  if (options.timeoutMs) {
    singleTimer = setTimeout(() => killChild("single"), options.timeoutMs);
  }
  if (options.idleTimeoutMs) {
    idleTimer = setTimeout(() => killChild("idle"), options.idleTimeoutMs);
  }
  if (options.hardTimeoutMs) {
    hardTimer = setTimeout(() => killChild("hard"), options.hardTimeoutMs);
  }

  const clearTimers = () => {
    if (singleTimer) {
      clearTimeout(singleTimer);
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    if (hardTimer) {
      clearTimeout(hardTimer);
    }
  };

  const resetIdleTimer = () => {
    if (options.idleTimeoutMs && idleTimer && !killed) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => killChild("idle"), options.idleTimeoutMs);
    }
  };

  child.stdout.on("data", (chunk) => {
    const value = chunk.toString();
    stdout += value;
    resetIdleTimer();
    options.onData?.(value);

    if (options.outputFormat === "stream-json") {
      stdoutBuffer += value;
      let newlineIndex = -1;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "assistant" && typeof event.message === "object" && event.message) {
            const message = event.message as { content?: Array<{ type?: string; text?: string }> };
            for (const block of message.content ?? []) {
              if (block.type === "text" && block.text) {
                resultText += block.text;
              }
            }
          } else if (event.type === "result") {
            if (typeof event.result === "string") {
              resultText = event.result || resultText;
            }
            if (typeof event.usage === "object" && event.usage) {
              const usage = event.usage as {
                input_tokens?: number;
                output_tokens?: number;
              };
              tokenUsage.input += usage.input_tokens ?? 0;
              tokenUsage.output += usage.output_tokens ?? 0;
            }
          }
        } catch {}
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const value = chunk.toString();
    stderr += value;
    resetIdleTimer();
    options.onStderr?.(value);
  });

  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
      console.error(`[llm] stdin error: ${error.code ?? error.message}`);
    }
  });
  child.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "ERR_STREAM_DESTROYED") {
      console.error(`[llm] stdout error: ${error.code ?? error.message}`);
    }
  });
  child.stderr.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "ERR_STREAM_DESTROYED") {
      console.error(`[llm] stderr error: ${error.code ?? error.message}`);
    }
  });

  child.stdin.end(prompt);

  return await new Promise<SpawnLlmResult>((resolve) => {
    child.on("close", (code) => {
      clearTimers();
      const durationMs = Date.now() - startTime;
      const output = options.outputFormat === "stream-json" ? resultText : stdout;

      if (killed) {
        resolve({
          status: "timeout",
          stdout: output,
          stderr,
          exitCode: code,
          timeoutKind,
          durationMs,
          tokenUsage
        });
        return;
      }

      if (code === 0) {
        resolve({
          status: "done",
          stdout: output,
          stderr,
          exitCode: 0,
          timeoutKind: null,
          durationMs,
          tokenUsage
        });
        return;
      }

      if (RATE_LIMIT_RE.test(stderr)) {
        resolve({
          status: "rate_limited",
          stdout: output,
          stderr,
          exitCode: code,
          timeoutKind: null,
          durationMs,
          tokenUsage
        });
        return;
      }

      resolve({
        status: "failed",
        stdout: output,
        stderr,
        exitCode: code,
        timeoutKind: null,
        durationMs,
        tokenUsage
      });
    });

    child.on("error", (error) => {
      clearTimers();
      const durationMs = Date.now() - startTime;
      resolve({
        status: "failed",
        stdout: "",
        stderr: error.message,
        exitCode: -1,
        timeoutKind: null,
        durationMs
      });
    });
  });
}

export async function llmText(prompt: string, options: Omit<CliLlmOptions, "outputFormat"> = {}): Promise<{
  text: string;
  tokenUsage?: {
    input: number;
    output: number;
  };
}> {
  const provider = options.provider ?? process.env.FST_LLM_PROVIDER ?? "codex";
  const outputFormat: CliOutputFormat = provider === "codex" ? "text" : "stream-json";

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const result = await spawnLlm(prompt, {
      ...options,
      provider,
      outputFormat
    });

    if (result.status === "rate_limited") {
      if (attempt < MAX_RATE_LIMIT_RETRIES) {
        const delay = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new Error("RATE_LIMITED");
    }

    if (result.status !== "done") {
      throw new Error(`LLM ${result.status}: ${result.stderr.slice(0, 200)}`);
    }

    return {
      text: result.stdout.trim(),
      tokenUsage: result.tokenUsage
    };
  }

  throw new Error("LLM failed after max retries");
}

export async function llmJson(prompt: string, options: Omit<CliLlmOptions, "outputFormat"> = {}): Promise<{
  data: unknown;
  tokenUsage?: {
    input: number;
    output: number;
  };
}> {
  const { text, tokenUsage } = await llmText(prompt, options);
  return {
    data: extractJson(text),
    tokenUsage
  };
}
