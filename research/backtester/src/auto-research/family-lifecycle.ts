import type { CandidateBacktestEvaluation, ResearchIterationRecord } from "./types.js";
import { calculateCandidateRiskAdjustedScore } from "./ranking.js";

export class FamilyLifecycleTracker {
  private stagnationStreak = new Map<string, number>();
  private consecutiveNegative = new Map<string, number>();
  private consecutiveBelowBaseline = new Map<string, number>();
  private iterationCounts = new Map<string, number>();
  private bestNetReturn = new Map<string, number>();
  private bestRiskAdjustedScore = new Map<string, number>();
  private retired = new Set<string>();
  private globalBestNet = -Infinity;
  private globalBestRepeatCount = 0;
  private readonly stagnationThreshold: number;
  private readonly iterationBudget: number;
  private readonly negativeRetireThreshold: number;
  private readonly globalConvergenceThreshold: number;
  private readonly belowBaselineRetireThreshold: number;
  private readonly hopelessScoreThreshold: number;
  private readonly hopelessMinIterations: number;

  constructor(params: {
    stagnationThreshold?: number;
    iterationBudget?: number;
    negativeRetireThreshold?: number;
    globalConvergenceThreshold?: number;
    belowBaselineRetireThreshold?: number;
    hopelessScoreThreshold?: number;
    hopelessMinIterations?: number;
  }) {
    this.stagnationThreshold = params.stagnationThreshold ?? 5;
    this.iterationBudget = params.iterationBudget ?? 15;
    this.negativeRetireThreshold = params.negativeRetireThreshold ?? 3;
    this.globalConvergenceThreshold = params.globalConvergenceThreshold ?? 3;
    this.belowBaselineRetireThreshold = params.belowBaselineRetireThreshold ?? 4;
    this.hopelessScoreThreshold = params.hopelessScoreThreshold ?? -0.2;
    this.hopelessMinIterations = params.hopelessMinIterations ?? 5;
  }

  restoreFromHistory(
    iterations: ResearchIterationRecord[],
    blockFamilyIds: Set<string>,
    compareEvaluations: (a: CandidateBacktestEvaluation, b: CandidateBacktestEvaluation) => number
  ): void {
    const EPSILON = 1e-6;
    for (const iteration of iterations) {
      const families = new Set<string>();
      for (const evaluation of iteration.evaluations) {
        const fid = evaluation.candidate.familyId;
        if (blockFamilyIds.size > 0 && !blockFamilyIds.has(fid)) continue;
        families.add(fid);
      }
      for (const fid of families) {
        this.iterationCounts.set(fid, (this.iterationCounts.get(fid) ?? 0) + 1);
        const iterBest = iteration.evaluations
          .filter((e) => e.candidate.familyId === fid)
          .sort(compareEvaluations)[0];
        const prevBest = this.bestNetReturn.get(fid) ?? -Infinity;
        const currentBest = iterBest?.summary.netReturn ?? -Infinity;
        if (currentBest > prevBest + EPSILON) {
          this.stagnationStreak.set(fid, 0);
          this.bestNetReturn.set(fid, currentBest);
        } else {
          this.stagnationStreak.set(fid, (this.stagnationStreak.get(fid) ?? 0) + 1);
        }
        // Restore consecutive negative
        if (iterBest && iterBest.summary.netReturn < 0) {
          this.consecutiveNegative.set(fid, (this.consecutiveNegative.get(fid) ?? 0) + 1);
        } else {
          this.consecutiveNegative.set(fid, 0);
        }
      }
    }
  }

  trackIteration(
    evaluations: CandidateBacktestEvaluation[],
    compareEvaluations: (a: CandidateBacktestEvaluation, b: CandidateBacktestEvaluation) => number
  ): string[] {
    const EPSILON = 1e-6;
    const newlyRetired: string[] = [];
    const families = new Set(evaluations.map((e) => e.candidate.familyId));

    // Track global best convergence
    const iterGlobalBest = evaluations.sort(compareEvaluations)[0];
    if (iterGlobalBest) {
      const net = iterGlobalBest.summary.netReturn;
      if (Math.abs(net - this.globalBestNet) < EPSILON) {
        this.globalBestRepeatCount++;
      } else if (net > this.globalBestNet) {
        this.globalBestNet = net;
        this.globalBestRepeatCount = 0;
      }
    }

    for (const fid of families) {
      if (this.retired.has(fid)) continue;
      this.iterationCounts.set(fid, (this.iterationCounts.get(fid) ?? 0) + 1);
      const prevBest = this.bestNetReturn.get(fid) ?? -Infinity;
      const iterBest = evaluations
        .filter((e) => e.candidate.familyId === fid)
        .sort(compareEvaluations)[0];
      const improved = iterBest && iterBest.summary.netReturn > prevBest + EPSILON;

      if (improved) {
        this.stagnationStreak.set(fid, 0);
        this.bestNetReturn.set(fid, iterBest.summary.netReturn);
      } else {
        const streak = (this.stagnationStreak.get(fid) ?? 0) + 1;
        this.stagnationStreak.set(fid, streak);
        if (streak >= this.stagnationThreshold) {
          this.retired.add(fid);
          newlyRetired.push(fid);
        }
      }

      // Consecutive negative retirement
      if (iterBest && iterBest.summary.netReturn < 0) {
        const negStreak = (this.consecutiveNegative.get(fid) ?? 0) + 1;
        this.consecutiveNegative.set(fid, negStreak);
        if (negStreak >= this.negativeRetireThreshold && !this.retired.has(fid)) {
          this.retired.add(fid);
          newlyRetired.push(fid);
        }
      } else {
        this.consecutiveNegative.set(fid, 0);
      }

      // Consecutive below-baseline retirement — all candidates lose to buy-and-hold
      if (iterBest) {
        const bh = iterBest.summary.buyAndHoldReturn;
        const underperforms = bh !== undefined && iterBest.summary.netReturn <= bh;
        if (underperforms) {
          const belowStreak = (this.consecutiveBelowBaseline.get(fid) ?? 0) + 1;
          this.consecutiveBelowBaseline.set(fid, belowStreak);
          if (belowStreak >= this.belowBaselineRetireThreshold && !this.retired.has(fid)) {
            this.retired.add(fid);
            newlyRetired.push(fid);
          }
        } else {
          this.consecutiveBelowBaseline.set(fid, 0);
        }
      }

      // Hopeless family — best-ever score still very low after several iterations
      const count = this.iterationCounts.get(fid) ?? 0;
      const bestScore = this.bestRiskAdjustedScore.get(fid) ?? -Infinity;
      if (iterBest) {
        const score = calculateCandidateRiskAdjustedScore(iterBest);
        if (score > bestScore) {
          this.bestRiskAdjustedScore.set(fid, score);
        }
      }
      const currentBestScore = this.bestRiskAdjustedScore.get(fid) ?? -Infinity;
      if (
        count >= this.hopelessMinIterations &&
        currentBestScore < this.hopelessScoreThreshold &&
        !this.retired.has(fid)
      ) {
        this.retired.add(fid);
        newlyRetired.push(fid);
      }

      // Budget exhaustion
      if (count >= this.iterationBudget && !this.retired.has(fid)) {
        this.retired.add(fid);
        newlyRetired.push(fid);
      }
    }

    return newlyRetired;
  }

  isGloballyConverged(): boolean {
    return this.globalBestRepeatCount >= this.globalConvergenceThreshold;
  }

  resetGlobalConvergence(): void {
    this.globalBestRepeatCount = 0;
  }

  isRetired(familyId: string): boolean { return this.retired.has(familyId); }
  retire(familyId: string): void { this.retired.add(familyId); }
  getRetiredSet(): Set<string> { return this.retired; }
  getStagnationStreak(): Map<string, number> { return this.stagnationStreak; }
  getIterationCounts(): Map<string, number> { return this.iterationCounts; }

  hasActiveFamily(familyIds: Iterable<string>): boolean {
    for (const fid of familyIds) {
      if (!this.retired.has(fid)) return true;
    }
    return false;
  }

  getSummary(): string {
    const entries = [...this.iterationCounts.entries()]
      .map(([fid, iter]) => {
        const stag = this.stagnationStreak.get(fid) ?? 0;
        const neg = this.consecutiveNegative.get(fid) ?? 0;
        const belowBH = this.consecutiveBelowBaseline.get(fid) ?? 0;
        const best = this.bestNetReturn.get(fid) ?? 0;
        const score = this.bestRiskAdjustedScore.get(fid);
        const status = this.retired.has(fid) ? "RETIRED" : "active";
        return `${fid}(${status} iter=${iter} stag=${stag} neg=${neg} belowBH=${belowBH} best=${(best*100).toFixed(2)}%${score !== undefined ? ` score=${score.toFixed(3)}` : ""})`;
      })
      .join(", ");
    return entries;
  }
}
