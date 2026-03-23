import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, readFile, writeFile, stat, readdir, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export type DaemonConfig = {
  /** CLI args to pass to the orchestrator (everything after `node --import tsx src/index.ts`) */
  orchArgs: string[];
  /** Directory where auto-research artifacts live */
  outputDir: string;
  /** Initial backoff delay on crash (ms). Default 30_000 */
  initialBackoffMs?: number;
  /** Max backoff delay (ms). Default 300_000 (5min) */
  maxBackoffMs?: number;
  /** Heartbeat timeout (ms) — if no heartbeat update for this long, kill + restart. Default: 0 (disabled) */
  heartbeatTimeoutMs?: number;
  /** Max Node heap size in MB for child processes. Default: 4096 */
  maxHeapMb?: number;
  /** Max disk usage before pausing (bytes). Default: 0 (disabled) */
  maxDiskUsageBytes?: number;
  /** Max consecutive crashes before daemon gives up. Default: 20 */
  maxConsecutiveCrashes?: number;
  /** Log function. Default: console.log */
  log?: (msg: string) => void;
};

type DaemonState = {
  pid: number;
  startedAt: string;
  restartCount: number;
  lastExitCode: number | null;
  lastExitSignal: string | null;
};

async function performStartupCleanup(outputDir: string, log: (msg: string) => void): Promise<void> {
  // Kill orphaned processes from previous runs
  try {
    const stateContent = await readFile(path.join(outputDir, "daemon-state.json"), "utf8");
    const prevState = JSON.parse(stateContent) as DaemonState;
    if (prevState.pid > 0 && prevState.lastExitCode === null) {
      try {
        process.kill(prevState.pid, 0);
        log(`[daemon] killing orphaned child PID ${prevState.pid}`);
        process.kill(prevState.pid, "SIGTERM");
        await new Promise((r) => setTimeout(r, 2000));
        try { process.kill(prevState.pid, "SIGKILL"); } catch { /* already dead */ }
      } catch { /* process already dead */ }
    }
  } catch { /* no prior state */ }

  // Clean stale temp directories
  try {
    const entries = await readdir(outputDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("tmp-")) {
        await rm(path.join(outputDir, entry.name), { recursive: true, force: true });
        log(`[daemon] cleaned stale temp dir: ${entry.name}`);
      }
    }
  } catch { /* best-effort */ }

  // Clean stale artifacts from previous runs
  try {
    const { cleanStaleRuns } = await import("./artifact-cleanup.js");
    await cleanStaleRuns({ parentDir: path.dirname(outputDir), retentionDays: 14, log });
  } catch { /* best-effort */ }
}

export async function runDaemon(config: DaemonConfig): Promise<void> {
  const log = config.log ?? console.log;
  const initialBackoff = config.initialBackoffMs ?? 30_000;
  const maxBackoff = config.maxBackoffMs ?? 300_000;
  const heartbeatTimeout = config.heartbeatTimeoutMs ?? 0;
  const defaultHeapMb = (() => {
    const totalMb = Math.round(os.totalmem() / 1024 / 1024);
    const available = Math.max(totalMb - 2048, 1024);
    return Math.min(Math.floor(available / 3), 4096);
  })();
  const maxHeapMb = config.maxHeapMb ?? defaultHeapMb;
  const maxConsecutiveCrashes = config.maxConsecutiveCrashes ?? 20;

  let backoffMs = initialBackoff;
  let restartCount = 0;
  let consecutiveCrashes = 0;
  let shuttingDown = false;
  let child: ChildProcess | null = null;
  let heartbeatChecker: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    shuttingDown = true;
    if (heartbeatChecker) clearInterval(heartbeatChecker);
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const daemonLogPath = path.join(config.outputDir, "daemon.jsonl");

  const logEvent = async (event: string, data?: Record<string, unknown>) => {
    const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
    log(`[daemon] ${event}${data ? " " + JSON.stringify(data) : ""}`);
    try {
      await appendFile(daemonLogPath, entry + "\n");
    } catch { /* best-effort */ }
  };

  const saveDaemonState = async (state: DaemonState) => {
    try {
      await writeFile(
        path.join(config.outputDir, "daemon-state.json"),
        JSON.stringify(state, null, 2)
      );
    } catch { /* best-effort */ }
  };

  const checkDiskSpace = async (): Promise<{ ok: boolean; freeMb: number }> => {
    try {
      const df = execSync(`df -BM --output=avail "${config.outputDir}" 2>/dev/null | tail -1`, { encoding: "utf8" });
      const freeMb = parseInt(df.replace(/[^0-9]/g, ""), 10);
      return { ok: freeMb > 2048, freeMb }; // require 2GB free
    } catch {
      return { ok: true, freeMb: -1 }; // can't check, assume OK
    }
  };

  const getMemoryUsageMb = (): number => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return Math.round((totalMem - freeMem) / 1024 / 1024);
  };

  await logEvent("daemon_start", {
    pid: process.pid,
    args: config.orchArgs,
    totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    cpuCount: os.cpus().length,
    maxHeapMb
  });

  await performStartupCleanup(config.outputDir, log);

  while (!shuttingDown) {
    // Pre-flight checks
    const disk = await checkDiskSpace();
    if (!disk.ok) {
      await logEvent("disk_low", { freeMb: disk.freeMb, requiredMb: 2048 });
      await new Promise((resolve) => setTimeout(resolve, 60_000)); // wait 1min, retry
      continue;
    }

    if (consecutiveCrashes >= maxConsecutiveCrashes) {
      await logEvent("daemon_stop", { reason: "max_consecutive_crashes", count: consecutiveCrashes });
      break;
    }

    const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
    if (freeMemMb < 500) {
      await logEvent("memory_pressure", { freeMemMb, requiredMb: 500 });
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      continue;
    }

    const args = [`--max-old-space-size=${maxHeapMb}`, "--import", "tsx", "src/index.ts", ...config.orchArgs];

    // Auto-resume: check for prior run state and lock status
    const resumeDir = config.outputDir;
    try {
      const lockPath = path.join(resumeDir, "run.lock.json");
      let lockStale = false;
      try {
        const lockContent = await readFile(lockPath, "utf8");
        const lock = JSON.parse(lockContent) as { pid: number };
        try {
          process.kill(lock.pid, 0);
          // Process is still alive — skip auto-resume, let it finish
          await logEvent("skip_resume", { reason: "lock held by live process", pid: lock.pid });
          await new Promise((resolve) => setTimeout(resolve, 10_000));
          continue;
        } catch {
          lockStale = true;
        }
      } catch {
        // No lock file — safe to proceed
      }

      const stateContent = await readFile(path.join(resumeDir, "run-state.json"), "utf8");
      const state = JSON.parse(stateContent);
      if (state && !config.orchArgs.includes("--auto-research-resume")) {
        args.push("--auto-research-resume", resumeDir);
        await logEvent("auto_resume", { resumeDir, lockStale });
      }
    } catch {
      // No prior state, fresh start
    }

    restartCount++;
    const startedAt = new Date().toISOString();

    await logEvent("child_spawn", { attempt: restartCount, backoffMs });

    child = spawn("node", args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: { ...process.env }
    });

    const childPid = child.pid ?? 0;

    await saveDaemonState({
      pid: childPid,
      startedAt,
      restartCount,
      lastExitCode: null,
      lastExitSignal: null
    });

    // Heartbeat monitoring
    if (heartbeatTimeout > 0) {
      heartbeatChecker = setInterval(async () => {
        try {
          const hbContent = await readFile(
            path.join(config.outputDir, "heartbeat.json"),
            "utf8"
          );
          const hb = JSON.parse(hbContent) as { updatedAt: string };
          const age = Date.now() - new Date(hb.updatedAt).getTime();
          if (age > heartbeatTimeout) {
            await logEvent("heartbeat_timeout", {
              ageMs: age,
              thresholdMs: heartbeatTimeout
            });
            if (child && !child.killed) {
              child.kill("SIGKILL");
            }
          }
        } catch {
          // heartbeat file doesn't exist yet, wait
        }
      }, Math.min(heartbeatTimeout / 2, 60_000));
    }

    // Wait for child to exit (handle both exit and spawn error)
    const { exitCode, signal } = await new Promise<{
      exitCode: number | null;
      signal: string | null;
    }>((resolve) => {
      child!.on("exit", (code, sig) => {
        resolve({ exitCode: code, signal: sig?.toString() ?? null });
      });
      child!.on("error", (err) => {
        logEvent("child_spawn_error", { error: err.message }).catch(() => {});
        resolve({ exitCode: 1, signal: null });
      });
    });

    if (heartbeatChecker) {
      clearInterval(heartbeatChecker);
      heartbeatChecker = null;
    }

    child = null;

    await saveDaemonState({
      pid: childPid,
      startedAt,
      restartCount,
      lastExitCode: exitCode,
      lastExitSignal: signal
    });

    await logEvent("child_exit", {
      code: exitCode,
      signal,
      restartCount
    });

    if (shuttingDown) {
      await logEvent("daemon_stop", { reason: "signal" });
      break;
    }

    if (exitCode === 0) {
      // Successful completion — reset backoff and crash counter
      backoffMs = initialBackoff;
      consecutiveCrashes = 0;

      if (config.orchArgs.includes("--continuous")) {
        await logEvent("continuous_restart", { reason: "successful completion" });
        continue;
      }

      await logEvent("daemon_stop", { reason: "child_success" });
      break;
    }

    // Crash — apply backoff
    consecutiveCrashes++;
    await logEvent("backoff_wait", {
      seconds: Math.round(backoffMs / 1000),
      consecutiveCrashes,
      usedMemMb: getMemoryUsageMb()
    });
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, maxBackoff);
  }

  process.removeListener("SIGINT", cleanup);
  process.removeListener("SIGTERM", cleanup);
  await logEvent("daemon_exit", { restartCount });
}
