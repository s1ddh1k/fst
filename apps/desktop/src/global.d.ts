declare global {
  interface FstDesktopOpsSnapshot {
    tmux: {
      available: boolean;
      sessionName: string;
      exists: boolean;
      windows: string[];
    };
    paperTrader: {
      managed: boolean;
      status: "starting" | "running" | "stopped" | "error" | "external";
      pid: number | null;
      startedAt: string | null;
      logPath: string | null;
      message: string;
    };
    logs: {
      collector: { name: string; updatedAt: string } | null;
      paper: { name: string; updatedAt: string } | null;
    };
    runbook: Array<{
      key: "tmux_workspace" | "tmux_attach" | "collector_status" | "paper_status";
      command: string;
    }>;
    generatedAt: string;
  }

  interface Window {
    fstDesktop?: {
      paperTraderBaseUrl?: string;
      getOpsSnapshot?: () => Promise<FstDesktopOpsSnapshot>;
    };
  }
}

export {};
