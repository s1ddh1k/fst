import { app, BrowserWindow, ipcMain } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);
const rootDir = path.resolve(__dirname, "../../..");
const logDir = path.join(rootDir, "logs");
const tmuxSessionName = process.env.FST_TMUX_SESSION ?? "fst";
const paperTraderBaseUrl = process.env.DESKTOP_API_BASE_URL ?? "http://127.0.0.1:8787";
const paperTraderUrl = new URL(paperTraderBaseUrl);
const managedPaperTraderHost = process.env.PAPER_TRADER_HOST ?? paperTraderUrl.hostname;
const managedPaperTraderPort = process.env.PAPER_TRADER_PORT ?? (paperTraderUrl.port || "8787");
const paperTraderCli = path.join(
  rootDir,
  "services",
  "paper-trader",
  "node_modules",
  ".bin",
  "tsx"
);

type PaperTraderRuntime = {
  managed: boolean;
  status: "starting" | "running" | "stopped" | "error" | "external";
  pid: number | null;
  startedAt: string | null;
  logPath: string | null;
  message: string;
};

let paperTraderProcess: ChildProcess | null = null;
let paperTraderLogStream: WriteStream | null = null;
let paperTraderLogPath: string | null = null;
let paperTraderStartedAt: string | null = null;
let paperTraderStatus: PaperTraderRuntime["status"] = "stopped";
let paperTraderMessage = "embedded paper-trader not started";
let ensurePaperTraderPromise: Promise<void> | null = null;

function isManagedPaperTraderUrl(): boolean {
  return ["127.0.0.1", "localhost"].includes(paperTraderUrl.hostname);
}

function getPaperTraderRuntime(): PaperTraderRuntime {
  return {
    managed: isManagedPaperTraderUrl(),
    status: isManagedPaperTraderUrl() ? paperTraderStatus : "external",
    pid: paperTraderProcess?.pid ?? null,
    startedAt: paperTraderStartedAt,
    logPath: paperTraderLogPath,
    message: isManagedPaperTraderUrl()
      ? paperTraderMessage
      : `external endpoint ${paperTraderBaseUrl}`
  };
}

async function ensureLogDir(): Promise<void> {
  await fs.mkdir(logDir, { recursive: true });
}

async function findLatestLog(prefix: string): Promise<{ name: string; updatedAt: string } | null> {
  try {
    const entries = await fs.readdir(logDir, { withFileTypes: true });
    const matches = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
        .map(async (entry) => {
          const filePath = path.join(logDir, entry.name);
          const stats = await fs.stat(filePath);
          return {
            name: entry.name,
            updatedAt: stats.mtime.toISOString(),
            mtimeMs: stats.mtimeMs
          };
        })
    );

    const latest = matches.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];

    if (!latest) {
      return null;
    }

    return {
      name: latest.name,
      updatedAt: latest.updatedAt
    };
  } catch {
    return null;
  }
}

async function readTmuxSnapshot(): Promise<{
  available: boolean;
  sessionName: string;
  exists: boolean;
  windows: string[];
}> {
  try {
    await execFileAsync("tmux", ["-V"]);
  } catch {
    return {
      available: false,
      sessionName: tmuxSessionName,
      exists: false,
      windows: []
    };
  }

  try {
    await execFileAsync("tmux", ["has-session", "-t", tmuxSessionName]);
  } catch {
    return {
      available: true,
      sessionName: tmuxSessionName,
      exists: false,
      windows: []
    };
  }

  try {
    const { stdout } = await execFileAsync("tmux", [
      "list-windows",
      "-t",
      tmuxSessionName,
      "-F",
      "#{window_name}"
    ]);

    return {
      available: true,
      sessionName: tmuxSessionName,
      exists: true,
      windows: stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean)
    };
  } catch {
    return {
      available: true,
      sessionName: tmuxSessionName,
      exists: true,
      windows: []
    };
  }
}

async function checkPaperTraderHealth(timeoutMs = 1200): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${paperTraderBaseUrl}/recommendation-snapshots?limit=1`, {
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForPaperTraderHealthy(deadlineMs = 8000): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < deadlineMs) {
    if (await checkPaperTraderHealth()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

function closePaperTraderLog(): void {
  paperTraderLogStream?.end();
  paperTraderLogStream = null;
}

async function ensurePaperTraderServer(): Promise<void> {
  if (!isManagedPaperTraderUrl()) {
    paperTraderStatus = "external";
    paperTraderMessage = `external endpoint ${paperTraderBaseUrl}`;
    return;
  }

  if (await checkPaperTraderHealth()) {
    paperTraderStatus = "running";
    paperTraderMessage = "embedded service is healthy";
    return;
  }

  if (paperTraderProcess || ensurePaperTraderPromise) {
    return ensurePaperTraderPromise ?? Promise.resolve();
  }

  ensurePaperTraderPromise = (async () => {
    await ensureLogDir();

    const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "");
    paperTraderLogPath = path.join(logDir, `desktop-paper-trader-${timestamp}.log`);
    paperTraderLogStream = createWriteStream(paperTraderLogPath, { flags: "a" });
    paperTraderStartedAt = new Date().toISOString();
    paperTraderStatus = "starting";
    paperTraderMessage = "starting embedded paper-trader service";

    const child = spawn(paperTraderCli, ["services/paper-trader/src/index.ts", "serve"], {
      cwd: rootDir,
      env: {
        ...process.env,
        PAPER_TRADER_HOST: managedPaperTraderHost,
        PAPER_TRADER_PORT: managedPaperTraderPort
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    paperTraderProcess = child;
    child.stdout.pipe(paperTraderLogStream);
    child.stderr.pipe(paperTraderLogStream);

    child.on("error", (error) => {
      paperTraderStatus = "error";
      paperTraderMessage = `failed to start embedded service: ${error.message}`;
    });

    child.on("exit", (code, signal) => {
      paperTraderProcess = null;
      closePaperTraderLog();

      if (paperTraderStatus === "starting" || paperTraderStatus === "running") {
        paperTraderStatus = code === 0 ? "stopped" : "error";
        paperTraderMessage =
          code === 0
            ? "embedded service stopped"
            : `embedded service exited (${code ?? "null"}${signal ? `, ${signal}` : ""})`;
      }
    });

    const healthy = await waitForPaperTraderHealthy();

    if (healthy) {
      paperTraderStatus = "running";
      paperTraderMessage = "embedded service is healthy";
    } else {
      paperTraderStatus = "error";
      paperTraderMessage = `embedded service did not become healthy on ${paperTraderBaseUrl}`;
    }
  })().finally(() => {
    ensurePaperTraderPromise = null;
  });

  return ensurePaperTraderPromise;
}

function stopPaperTraderServer(): void {
  if (paperTraderProcess) {
    paperTraderProcess.kill("SIGTERM");
    paperTraderProcess = null;
  }

  closePaperTraderLog();
  if (isManagedPaperTraderUrl()) {
    paperTraderStatus = "stopped";
    paperTraderMessage = "embedded service stopped";
  }
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      zoomFactor: 1.5
    },
    backgroundColor: "#f1ebdc",
    title: "fst desktop"
  });

  await window.loadFile(path.join(__dirname, "renderer/index.html"));
}

ipcMain.handle("fst:get-ops-snapshot", async () => {
  await ensurePaperTraderServer();

  const [tmux, collectorLog, paperLog] = await Promise.all([
    readTmuxSnapshot(),
    findLatestLog("collector-"),
    findLatestLog("paper-session-")
  ]);

  return {
    tmux,
    logs: {
      collector: collectorLog,
      paper: paperLog
    },
    paperTrader: getPaperTraderRuntime(),
    runbook: [
      {
        key: "tmux_workspace",
        command: "bash infra/scripts/tmux-fst.sh up"
      },
      {
        key: "tmux_attach",
        command: "bash infra/scripts/tmux-fst.sh attach"
      },
      {
        key: "collector_status",
        command: "bash infra/scripts/check-collector-status.sh"
      },
      {
        key: "paper_status",
        command: "bash infra/scripts/check-paper-session-status.sh"
      }
    ],
    generatedAt: new Date().toISOString()
  };
});

app.whenReady().then(async () => {
  await ensurePaperTraderServer();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("before-quit", () => {
  stopPaperTraderServer();
});

app.on("window-all-closed", () => {
  stopPaperTraderServer();

  if (process.platform !== "darwin") {
    app.quit();
  }
});
