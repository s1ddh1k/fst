import type { CandidateBacktestEvaluation, ResearchIterationRecord } from "./types.js";

export class FamilyLifecycleTracker {
  private stagnationStreak = new Map<string, number>();
  private iterationCounts = new Map<string, number>();
  private bestNetReturn = new Map<string, number>();
  private retired = new Set<string>();
  private readonly stagnationThreshold: number;
  private readonly iterationBudget: number;

  constructor(params: { stagnationThreshold?: number; iterationBudget?: number }) {
    this.stagnationThreshold = params.stagnationThreshold ?? 8;
    this.iterationBudget = params.iterationBudget ?? 20;
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

    for (const fid of families) {
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
        if (streak >= this.stagnationThreshold && !this.retired.has(fid)) {
          this.retired.add(fid);
          newlyRetired.push(fid);
        }
      }

      const count = this.iterationCounts.get(fid) ?? 0;
      if (count >= this.iterationBudget && !this.retired.has(fid)) {
        this.retired.add(fid);
        newlyRetired.push(fid);
      }
    }

    return newlyRetired;
  }

  isRetired(familyId: string): boolean {
    return this.retired.has(familyId);
  }

  retire(familyId: string): void {
    this.retired.add(familyId);
  }

  getRetiredSet(): Set<string> {
    return this.retired;
  }

  getStagnationStreak(): Map<string, number> {
    return this.stagnationStreak;
  }

  getIterationCounts(): Map<string, number> {
    return this.iterationCounts;
  }

  hasActiveFamily(familyIds: Iterable<string>): boolean {
    for (const fid of familyIds) {
      if (!this.retired.has(fid)) return true;
    }
    return false;
  }

  getSummary(): string {
    const entries = [...this.stagnationStreak.entries()]
      .map(([fid, streak]) => `${fid}:stag=${streak},iter=${this.iterationCounts.get(fid) ?? 0}`)
      .join(" ");
    return `retired=${this.retired.size} ${entries}`;
  }
}
