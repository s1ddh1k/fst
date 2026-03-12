import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { PAPER_TRADER_HOST, PAPER_TRADER_PORT } from "./config.js";
import { runRecommendedLivePaperTrading } from "./runtime.js";
import {
  getPaperSessionById,
  getPaperSessionStatus,
  getRecommendationSnapshots,
  getRecommendations,
  startRecommendedPaperSession
} from "./service.js";

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function getSessionIdFromPath(pathname: string): number | null {
  const match = pathname.match(/^\/sessions\/(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function getRunSessionIdFromPath(pathname: string): number | null {
  const match = pathname.match(/^\/sessions\/(\d+)\/run$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export async function startPaperTraderServer(): Promise<void> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "OPTIONS") {
        sendJson(response, 204, null);
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/recommendations") {
        const recommendations = await getRecommendations({
          regimeName: url.searchParams.get("regime") ?? undefined,
          universeName: url.searchParams.get("universe") ?? undefined,
          timeframe: url.searchParams.get("timeframe") ?? undefined,
          limit: url.searchParams.get("limit")
            ? Number.parseInt(url.searchParams.get("limit") ?? "5", 10)
            : undefined
        });

        sendJson(response, 200, {
          items: recommendations
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/recommendation-snapshots") {
        const snapshots = await getRecommendationSnapshots(
          url.searchParams.get("limit")
            ? Number.parseInt(url.searchParams.get("limit") ?? "20", 10)
            : 20
        );

        sendJson(response, 200, {
          items: snapshots
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/sessions") {
        const { getRecentPaperSessions } = await import("./service.js");
        const sessions = await getRecentPaperSessions(
          url.searchParams.get("limit")
            ? Number.parseInt(url.searchParams.get("limit") ?? "20", 10)
            : 20
        );

        sendJson(response, 200, {
          items: sessions
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/sessions") {
        const body = await readJsonBody(request);
        const result = await startRecommendedPaperSession({
          marketCode: String(body.marketCode ?? body.market_code ?? "KRW-BTC"),
          rank: body.rank ? Number(body.rank) : undefined,
          regimeName: body.regimeName ? String(body.regimeName) : undefined,
          universeName: body.universeName ? String(body.universeName) : undefined,
          timeframe: body.timeframe ? String(body.timeframe) : undefined,
          startingBalance: body.startingBalance ? Number(body.startingBalance) : undefined
        });

        sendJson(response, 201, result);
        return;
      }

      if (request.method === "GET") {
        const sessionId = getSessionIdFromPath(url.pathname);

        if (sessionId) {
          const status = await getPaperSessionStatus(sessionId);

          if (!status.session) {
            sendJson(response, 404, { error: "Session not found" });
            return;
          }

          sendJson(response, 200, status);
          return;
        }
      }

      if (request.method === "POST") {
        const sessionId = getRunSessionIdFromPath(url.pathname);

        if (sessionId) {
          const body = await readJsonBody(request);
          const session = await getPaperSessionById(sessionId);

          if (!session) {
            sendJson(response, 404, { error: "Session not found" });
            return;
          }

          const recommendations = await getRecommendations({
            regimeName: body.regimeName ? String(body.regimeName) : undefined,
            universeName: body.universeName ? String(body.universeName) : undefined,
            timeframe: session.timeframe,
            limit: 10
          });
          const recommendation =
            recommendations.find((item) => item.strategyNames.join(" + ") === session.strategyName) ??
            recommendations[0];

          if (!recommendation) {
            sendJson(response, 404, { error: "No active recommendation available for session" });
            return;
          }

          void runRecommendedLivePaperTrading({
            sessionId: session.id,
            strategyName: recommendation.strategyNames[0],
            parametersJson: recommendation.parametersJson,
            marketCode: session.marketCode,
            timeframe: session.timeframe,
            startingBalance: session.startingBalance,
            maxEvents: body.maxEvents ? Number(body.maxEvents) : undefined
          });

          sendJson(response, 202, {
            sessionId: session.id,
            status: "started"
          });
          return;
        }
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(PAPER_TRADER_PORT, PAPER_TRADER_HOST, () => resolve());
  });

  console.log(`paper-trader server listening on http://${PAPER_TRADER_HOST}:${PAPER_TRADER_PORT}`);
}
