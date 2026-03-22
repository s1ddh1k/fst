import { readFile } from "node:fs/promises";
import path from "node:path";

export type StrategyRegimePublicationVerification =
  | {
      kind: "auto_research";
      outputDir: string;
    }
  | {
      kind: "deterministic_bb";
      outputDir: string;
    }
  | {
      kind: "unsafe_override";
      reason: string;
    };

export type StrategyRegimePublicationEvidence = {
  status: "verified" | "unsafe_override";
  sourceKind: StrategyRegimePublicationVerification["kind"];
  outputDir: string | null;
  checkedAt: string;
  details: Record<string, unknown>;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toRecord(value: unknown, description: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${description} is not a JSON object.`);
  }

  return value;
}

function toStringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function nestedBoolean(record: JsonRecord, keys: string[]): boolean | undefined {
  let current: unknown = record;

  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return typeof current === "boolean" ? current : undefined;
}

async function readJson(filePath: string, description: string): Promise<JsonRecord> {
  try {
    const raw = await readFile(filePath, "utf8");
    return toRecord(JSON.parse(raw), description);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${description} could not be read at ${filePath}: ${reason}`);
  }
}

async function resolveAutoResearchVerification(outputDir: string): Promise<StrategyRegimePublicationEvidence> {
  const statusPath = path.join(outputDir, "status.json");
  const reportPath = path.join(outputDir, "report.json");
  const auditPath = path.join(outputDir, "artifact-audit.json");

  const [status, report, audit] = await Promise.all([
    readJson(statusPath, "auto-research status"),
    readJson(reportPath, "auto-research report"),
    readJson(auditPath, "auto-research artifact audit")
  ]);

  const statusPhase = toStringField(status, "phase");
  const reportOutcome = toStringField(report, "outcome");
  const statusAuditOk = nestedBoolean(status, ["verification", "artifactAudit", "ok"]);
  const reportAuditOk = nestedBoolean(report, ["verification", "artifactAudit", "ok"]);
  const auditOk = typeof audit.ok === "boolean" ? audit.ok : undefined;

  if (statusPhase !== "completed") {
    throw new Error(
      `Auto-research output ${outputDir} is not publishable: status phase is ${statusPhase ?? "unknown"}.`
    );
  }

  if (reportOutcome !== "completed") {
    throw new Error(
      `Auto-research output ${outputDir} is not publishable: report outcome is ${reportOutcome ?? "unknown"}.`
    );
  }

  if (statusAuditOk !== true || reportAuditOk !== true || auditOk !== true) {
    throw new Error(`Auto-research output ${outputDir} is not publishable: artifact verification did not pass.`);
  }

  return {
    status: "verified",
    sourceKind: "auto_research",
    outputDir,
    checkedAt: new Date().toISOString(),
    details: {
      statusPath,
      reportPath,
      auditPath,
      statusPhase,
      reportOutcome
    }
  };
}

async function resolveDeterministicBbVerification(outputDir: string): Promise<StrategyRegimePublicationEvidence> {
  const statusPath = path.join(outputDir, "status.json");
  const auditPath = path.join(outputDir, "audit.json");
  const replayPath = path.join(outputDir, "replay-verification.json");
  const wrapperStatusPath = path.join(outputDir, "wrapper-status.json");

  const status = await readJson(statusPath, "deterministic BB status");
  const audit = await readJson(auditPath, "deterministic BB artifact audit");
  const replay = await readJson(replayPath, "deterministic BB replay verification");
  let wrapperStatus: JsonRecord | undefined;

  try {
    wrapperStatus = await readJson(wrapperStatusPath, "deterministic BB wrapper status");
  } catch {
    wrapperStatus = undefined;
  }

  const statusPhase = toStringField(status, "phase");
  const wrapperPhase = wrapperStatus ? toStringField(wrapperStatus, "phase") : undefined;
  const auditOk = typeof audit.ok === "boolean" ? audit.ok : undefined;
  const replayOk = typeof replay.ok === "boolean" ? replay.ok : undefined;

  if (statusPhase !== "completed") {
    throw new Error(`Deterministic BB output ${outputDir} is not publishable: status phase is ${statusPhase ?? "unknown"}.`);
  }

  if (wrapperPhase && wrapperPhase !== "completed") {
    throw new Error(
      `Deterministic BB output ${outputDir} is not publishable: wrapper phase is ${wrapperPhase}.`
    );
  }

  if (auditOk !== true || replayOk !== true) {
    throw new Error(`Deterministic BB output ${outputDir} is not publishable: audit or replay verification failed.`);
  }

  return {
    status: "verified",
    sourceKind: "deterministic_bb",
    outputDir,
    checkedAt: new Date().toISOString(),
    details: {
      statusPath,
      auditPath,
      replayPath,
      wrapperStatusPath: wrapperStatus ? wrapperStatusPath : null,
      statusPhase,
      wrapperPhase: wrapperPhase ?? null
    }
  };
}

export async function resolveStrategyRegimePublicationVerification(
  verification: StrategyRegimePublicationVerification
): Promise<StrategyRegimePublicationEvidence> {
  if (verification.kind === "unsafe_override") {
    return {
      status: "unsafe_override",
      sourceKind: verification.kind,
      outputDir: null,
      checkedAt: new Date().toISOString(),
      details: {
        reason: verification.reason
      }
    };
  }

  if (verification.kind === "auto_research") {
    return resolveAutoResearchVerification(verification.outputDir);
  }

  return resolveDeterministicBbVerification(verification.outputDir);
}
