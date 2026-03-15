import { closeDb } from "./db.js";
import { runRecommendedLivePaperTrading } from "./runtime.js";
import { startPaperTraderServer } from "./server.js";
import {
  getRecommendationForSession,
  getPaperSessionById,
  getPaperSessionStatus,
  getRecommendationSnapshots,
  getRecommendations,
  startRecommendedPaperSession
} from "./service.js";

function getOption(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "show-recommendations";
  const shouldKeepDbOpen = command === "serve";

  try {
    if (command === "show-recommendations") {
      const recommendations = await getRecommendations({
        regimeName: getOption(process.argv, "--regime"),
        universeName: getOption(process.argv, "--universe"),
        timeframe: getOption(process.argv, "--timeframe"),
        limit: Number.parseInt(getOption(process.argv, "--limit") ?? "5", 10)
      });

      for (const recommendation of recommendations) {
        console.log(
          [
            `rank=${recommendation.rank}`,
            `strategy=${recommendation.strategyNames.join(" + ")}`,
            `avgTest=${(recommendation.avgTestReturn * 100).toFixed(2)}%`,
            `mdd=${(recommendation.avgTestDrawdown * 100).toFixed(2)}%`,
            `markets=${recommendation.marketCount}`
          ].join(" | ")
        );
      }

      return;
    }

    if (command === "show-recommendation-snapshots") {
      const snapshots = await getRecommendationSnapshots(
        Number.parseInt(getOption(process.argv, "--limit") ?? "10", 10)
      );

      for (const snapshot of snapshots) {
        console.log(
          [
            `regime=${snapshot.regimeName}`,
            `universe=${snapshot.universeName}`,
            `timeframe=${snapshot.timeframe}`,
            `holdoutDays=${snapshot.holdoutDays}`,
            `count=${snapshot.recommendationCount}`,
            `bestAvgTest=${(snapshot.bestAvgTestReturn * 100).toFixed(2)}%`,
            `worstMdd=${(snapshot.worstAvgTestDrawdown * 100).toFixed(2)}%`,
            `updatedAt=${snapshot.updatedAt.toISOString()}`
          ].join(" | ")
        );
      }

      return;
    }

    if (command === "serve") {
      await startPaperTraderServer();
      return;
    }

    if (command === "start-session") {
      const { recommendation, session } = await startRecommendedPaperSession({
        marketCode: getOption(process.argv, "--market"),
        rank: Number.parseInt(getOption(process.argv, "--rank") ?? "1", 10),
        regimeName: getOption(process.argv, "--regime"),
        universeName: getOption(process.argv, "--universe"),
        timeframe: getOption(process.argv, "--timeframe"),
        startingBalance: Number.parseFloat(getOption(process.argv, "--balance") ?? "1000000")
      });

      console.log(
        [
          `sessionId=${session.id}`,
          `market=${session.marketCode}`,
          `strategy=${session.strategyName}`,
          `timeframe=${session.timeframe}`,
          `rank=${recommendation.rank}`,
          `status=${session.status}`
        ].join(" | ")
      );
      return;
    }

    if (command === "run-session") {
      const sessionId = Number.parseInt(getOption(process.argv, "--session-id") ?? "0", 10);

      if (!sessionId) {
        throw new Error("--session-id is required");
      }

      const session = await getPaperSessionById(sessionId);

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const recommendation = await getRecommendationForSession(session, {
        regimeName: getOption(process.argv, "--regime"),
        universeName: getOption(process.argv, "--universe")
      });

      if (!recommendation) {
        throw new Error("No active recommendation available for session");
      }

      await runRecommendedLivePaperTrading({
        sessionId: session.id,
        strategyType: recommendation.strategyType,
        strategyName: recommendation.strategyNames[0],
        parametersJson: recommendation.parametersJson,
        marketCode: session.marketCode,
        timeframe: session.timeframe,
        startingBalance: session.startingBalance,
        currentBalance: session.currentBalance,
        universeName: recommendation.universeName,
        maxEvents: Number.parseInt(getOption(process.argv, "--max-events") ?? "0", 10) || undefined
      });

      console.log(`sessionId=${session.id} | status=stopped`);
      return;
    }

    if (command === "status") {
      const sessionId = Number.parseInt(getOption(process.argv, "--session-id") ?? "0", 10);

      if (!sessionId) {
        throw new Error("--session-id is required");
      }

      const status = await getPaperSessionStatus(sessionId);

      if (!status.session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      console.log(
        [
          `sessionId=${status.session.id}`,
          `market=${status.session.marketCode}`,
          `strategy=${status.session.strategyName}`,
          `timeframe=${status.session.timeframe}`,
          `status=${status.session.status}`,
          `balance=${status.session.currentBalance.toFixed(2)}`
        ].join(" | ")
      );

      if (status.position) {
        console.log(
          [
            `positionQty=${status.position.quantity.toFixed(8)}`,
            `avgEntry=${status.position.avgEntryPrice.toFixed(2)}`,
            `mark=${(status.position.markPrice ?? 0).toFixed(2)}`,
            `unrealized=${status.position.unrealizedPnl.toFixed(2)}`,
            `realized=${status.position.realizedPnl.toFixed(2)}`
          ].join(" | ")
        );
      }

      for (const position of status.positions) {
        console.log(
          [
            `positionMarket=${position.marketCode}`,
            `positionQty=${position.quantity.toFixed(8)}`,
            `avgEntry=${position.avgEntryPrice.toFixed(2)}`,
            `mark=${(position.markPrice ?? 0).toFixed(2)}`,
            `unrealized=${position.unrealizedPnl.toFixed(2)}`,
            `realized=${position.realizedPnl.toFixed(2)}`
          ].join(" | ")
        );
      }

      for (const order of status.recentOrders) {
        console.log(
          [
            `market=${order.marketCode ?? "-"}`,
            `order=${order.side}`,
            `price=${(order.executedPrice ?? 0).toFixed(2)}`,
            `qty=${order.quantity.toFixed(8)}`,
            `fee=${order.fee.toFixed(2)}`,
            `status=${order.status}`
          ].join(" | ")
        );
      }

      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    if (!shouldKeepDbOpen) {
      await closeDb();
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
