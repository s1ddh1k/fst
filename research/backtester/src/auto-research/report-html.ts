import type { AutoResearchRunReport } from "./types.js";
import type { AutoResearchStatus } from "./run-manager.js";

type AutoResearchLeaderboardEntry = {
  iteration: number;
  candidateId: string;
  familyId: string;
  netReturn: number;
  maxDrawdown: number;
  tradeCount: number;
  parameters?: Record<string, number>;
};

type AutoResearchCandidateLedgerEntry = {
  fingerprint: string;
  familyId: string;
  parameters: Record<string, number>;
  firstCandidateId: string;
  lastCandidateId: string;
  firstIteration: number;
  lastIteration: number;
  appearances: number;
  bestNetReturn: number;
  bestTradeCount: number;
  positiveAppearances: number;
  tradefulAppearances: number;
};

type AutoResearchFamilySummaryEntry = {
  familyId: string;
  evaluations: number;
  uniqueCandidates: number;
  positiveEvaluations: number;
  tradefulEvaluations: number;
  bestNetReturn: number;
  bestTradeNetReturn?: number;
  bestTradeCount: number;
  totalTrades: number;
  lastIteration: number;
};

function pct(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "-";
  }

  return `${(value * 100).toFixed(2)}%`;
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function topReasons(reasons: Record<string, number>, limit = 4): string {
  const entries = Object.entries(reasons)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);

  if (entries.length === 0) {
    return "-";
  }

  return entries.map(([reason, count]) => `${reason} (${count})`).join(", ");
}

export function renderAutoResearchHtml(report: AutoResearchRunReport): string {
  return renderAutoResearchHtmlWithOptions(report, {});
}

export function renderAutoResearchHtmlWithOptions(
  report: AutoResearchRunReport,
  options: {
    status?: AutoResearchStatus;
    leaderboard?: AutoResearchLeaderboardEntry[];
    rawLeaderboard?: AutoResearchLeaderboardEntry[];
    candidateLedger?: AutoResearchCandidateLedgerEntry[];
    familySummary?: AutoResearchFamilySummaryEntry[];
  }
): string {
  const best = report.bestCandidate;
  const bestTrade = report.bestTradeCandidate;
  const status = options.status;
  const leaderboardRows = (options.leaderboard ?? [])
    .slice(0, 12)
    .map(
      (entry) => `
            <tr>
              <td>${entry.iteration}</td>
              <td>${esc(entry.candidateId)}</td>
              <td>${esc(entry.familyId)}</td>
              <td>${pct(entry.netReturn)}</td>
              <td>${pct(entry.maxDrawdown)}</td>
              <td>${entry.tradeCount}</td>
            </tr>`
    )
    .join("");
  const rawLeaderboardRows = (options.rawLeaderboard ?? [])
    .slice(0, 12)
    .map(
      (entry) => `
            <tr>
              <td>${entry.iteration}</td>
              <td>${esc(entry.candidateId)}</td>
              <td>${esc(entry.familyId)}</td>
              <td><code>${esc(JSON.stringify(entry.parameters ?? {}))}</code></td>
              <td>${pct(entry.netReturn)}</td>
              <td>${pct(entry.maxDrawdown)}</td>
              <td>${entry.tradeCount}</td>
            </tr>`
    )
    .join("");
  const candidateLedgerRows = (options.candidateLedger ?? [])
    .slice(0, 12)
    .map(
      (entry) => `
            <tr>
              <td>${esc(entry.familyId)}</td>
              <td><code>${esc(JSON.stringify(entry.parameters ?? {}))}</code></td>
              <td>${entry.appearances}</td>
              <td>${entry.tradefulAppearances}</td>
              <td>${pct(entry.bestNetReturn)}</td>
              <td>${entry.bestTradeCount}</td>
              <td>${entry.firstIteration} -> ${entry.lastIteration}</td>
            </tr>`
    )
    .join("");
  const familySummaryRows = (options.familySummary ?? [])
    .slice(0, 12)
    .map(
      (entry) => `
            <tr>
              <td>${esc(entry.familyId)}</td>
              <td>${entry.evaluations}</td>
              <td>${entry.uniqueCandidates}</td>
              <td>${entry.tradefulEvaluations}</td>
              <td>${entry.positiveEvaluations}</td>
              <td>${pct(entry.bestNetReturn)}</td>
              <td>${pct(entry.bestTradeNetReturn)}</td>
              <td>${entry.bestTradeCount}</td>
              <td>${entry.lastIteration}</td>
            </tr>`
    )
    .join("");
  const iterationRows = report.iterations
    .map((iteration) => {
      const evalRows = iteration.evaluations
        .map(
          (evaluation) => `
            <tr>
              <td>${esc(evaluation.candidate.candidateId)}</td>
              <td>${esc(evaluation.candidate.familyId)}</td>
              <td><code>${esc(JSON.stringify(evaluation.candidate.parameters))}</code></td>
              <td>${pct(evaluation.summary.netReturn)}</td>
              <td>${pct(evaluation.summary.maxDrawdown)}</td>
              <td>${evaluation.summary.tradeCount}</td>
              <td>${topReasons(evaluation.diagnostics.reasons.strategy)}</td>
              <td>${topReasons(evaluation.diagnostics.reasons.coordinator)}</td>
              <td>${topReasons(evaluation.diagnostics.reasons.execution)}</td>
            </tr>`
        )
        .join("");

      return `
        <section class="iteration">
          <h2>Iteration ${iteration.iteration}</h2>
          <p class="summary">${esc(iteration.proposal.researchSummary)}</p>
          <p class="review"><strong>Review:</strong> ${esc(iteration.review.summary)}</p>
          <table>
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Family</th>
                <th>Parameters</th>
                <th>Net</th>
                <th>Drawdown</th>
                <th>Trades</th>
                <th>Strategy Reasons</th>
                <th>Coordinator Reasons</th>
                <th>Execution Reasons</th>
              </tr>
            </thead>
            <tbody>${evalRows}</tbody>
          </table>
        </section>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Auto Research Report</title>
  <style>
    :root { color-scheme: light; --bg:#f4f0e8; --card:#fffaf2; --ink:#1f1a17; --muted:#6f6258; --line:#d8cdbf; --accent:#ad4e2f; }
    body { margin:0; font-family: "Iowan Old Style", "Palatino Linotype", serif; background:linear-gradient(180deg,#f6f1e7,#efe5d6); color:var(--ink); }
    main { max-width:1100px; margin:0 auto; padding:32px 20px 60px; }
    .hero, .iteration { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:20px 22px; box-shadow:0 12px 30px rgba(45,30,12,0.08); }
    .hero { margin-bottom:22px; }
    .meta { color:var(--muted); margin:0 0 8px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-top:14px; }
    .stat { padding:12px; border-radius:12px; background:#f2e8da; }
    .stat .label { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .stat .value { display:block; font-size:20px; margin-top:6px; }
    .iteration { margin-top:18px; }
    h1,h2 { margin:0 0 10px; font-weight:700; }
    p { line-height:1.45; }
    table { width:100%; border-collapse:collapse; margin-top:12px; font-size:14px; }
    th, td { text-align:left; padding:10px 8px; border-top:1px solid var(--line); vertical-align:top; }
    th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    code { font-size:12px; white-space:pre-wrap; word-break:break-word; }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <p class="meta">Generated ${esc(report.generatedAt)}</p>
      <h1>Auto Research Report</h1>
      ${
        status
          ? `<p class="status"><strong>Status:</strong> ${esc(status.phase)} | iteration ${status.iteration}/${status.totalIterations} | ${esc(status.message)}</p>`
          : ""
      }
      <div class="grid">
        <div class="stat"><span class="label">Universe</span><span class="value">${esc(report.config.universeName)}</span></div>
        <div class="stat"><span class="label">Iterations</span><span class="value">${report.iterations.length}</span></div>
        <div class="stat"><span class="label">Candidates / Iter</span><span class="value">${report.config.candidatesPerIteration}</span></div>
        <div class="stat"><span class="label">Parallelism</span><span class="value">${report.config.parallelism ?? 1}</span></div>
        <div class="stat"><span class="label">Best Raw</span><span class="value">${esc(best?.candidate.candidateId ?? "-")}</span></div>
        <div class="stat"><span class="label">Best Raw Net</span><span class="value">${pct(best?.summary.netReturn)}</span></div>
        <div class="stat"><span class="label">Best With Trades</span><span class="value">${esc(bestTrade?.candidate.candidateId ?? "-")}</span></div>
        <div class="stat"><span class="label">Best Trade Net</span><span class="value">${pct(bestTrade?.summary.netReturn)}</span></div>
        <div class="stat"><span class="label">Unique Candidates</span><span class="value">${options.candidateLedger?.length ?? 0}</span></div>
        <div class="stat"><span class="label">Tracked Families</span><span class="value">${options.familySummary?.length ?? 0}</span></div>
      </div>
    </section>
    ${
      familySummaryRows
        ? `<section class="iteration">
          <h2>Family Summary</h2>
          <table>
            <thead>
              <tr>
                <th>Family</th>
                <th>Evals</th>
                <th>Unique Candidates</th>
                <th>Tradeful</th>
                <th>Positive</th>
                <th>Best Net</th>
                <th>Best Trade Net</th>
                <th>Best Trade Count</th>
                <th>Last Iter</th>
              </tr>
            </thead>
            <tbody>${familySummaryRows}</tbody>
          </table>
        </section>`
        : ""
    }
    ${
      leaderboardRows
        ? `<section class="iteration">
          <h2>Unique Leaderboard</h2>
          <table>
            <thead>
              <tr>
                <th>Iteration</th>
                <th>Candidate</th>
                <th>Family</th>
                <th>Net</th>
                <th>Drawdown</th>
                <th>Trades</th>
              </tr>
            </thead>
            <tbody>${leaderboardRows}</tbody>
          </table>
        </section>`
        : ""
    }
    ${
      candidateLedgerRows
        ? `<section class="iteration">
          <h2>Candidate Ledger</h2>
          <table>
            <thead>
              <tr>
                <th>Family</th>
                <th>Parameters</th>
                <th>Appearances</th>
                <th>Tradeful</th>
                <th>Best Net</th>
                <th>Best Trades</th>
                <th>Iteration Span</th>
              </tr>
            </thead>
            <tbody>${candidateLedgerRows}</tbody>
          </table>
        </section>`
        : ""
    }
    ${
      rawLeaderboardRows
        ? `<section class="iteration">
          <h2>Raw Leaderboard</h2>
          <table>
            <thead>
              <tr>
                <th>Iteration</th>
                <th>Candidate</th>
                <th>Family</th>
                <th>Parameters</th>
                <th>Net</th>
                <th>Drawdown</th>
                <th>Trades</th>
              </tr>
            </thead>
            <tbody>${rawLeaderboardRows}</tbody>
          </table>
        </section>`
        : ""
    }
    ${iterationRows}
  </main>
</body>
</html>
`;
}
