import { startTransition, useEffect, useEffectEvent, useState } from "react";

import { activeRegimeName, apiBaseUrl } from "../config";
import type {
  DictionaryKey,
  Recommendation,
  RecommendationSnapshot,
  Session,
  SessionDetailPayload
} from "../types";

type TFunction = (key: DictionaryKey, values?: Record<string, string | number>) => string;

function toUserMessage(error: unknown, t: TFunction) {
  const message = error instanceof Error ? error.message : String(error);

  if (/fetch failed|failed to fetch|networkerror/i.test(message)) {
    return t("apiOfflineReasonFetch");
  }

  if (/request failed:/i.test(message)) {
    return t("apiOfflineReasonHttp");
  }

  return message;
}

function request<T>(path: string, options?: RequestInit): Promise<T> {
  return fetch(`${apiBaseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  }).then(async (response) => {
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? `Request failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  });
}

export function useDesktopData(props: {
  timeframe: string;
  market: string;
  balance: string;
  t: TFunction;
}) {
  const { timeframe, market, balance, t } = props;
  const [opsSnapshot, setOpsSnapshot] = useState<FstDesktopOpsSnapshot | null>(null);
  const [snapshots, setSnapshots] = useState<RecommendationSnapshot[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailPayload | null>(null);
  const [apiHealthy, setApiHealthy] = useState(false);
  const [apiMessage, setApiMessage] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState<"start-session" | "run-session" | "">("");

  const loadSessionDetail = useEffectEvent(async (sessionId: number) => {
    startTransition(() => {
      setIsDetailLoading(true);
    });

    try {
      const payload = await request<SessionDetailPayload>(`/sessions/${sessionId}`);
      startTransition(() => {
        setSessionDetail(payload);
      });
    } finally {
      startTransition(() => {
        setIsDetailLoading(false);
      });
    }
  });

  const refreshAll = useEffectEvent(async () => {
    startTransition(() => {
      setIsRefreshing(true);
      setActionError("");
    });

    if (window.fstDesktop?.getOpsSnapshot) {
      const snapshot = await window.fstDesktop.getOpsSnapshot();
      startTransition(() => {
        setOpsSnapshot(snapshot);
        if (snapshot.paperTrader.status === "starting") {
          setApiHealthy(false);
          setApiMessage(t("apiStartingMeta"));
        }
      });
    }

    try {
      const [snapshotPayload, recommendationPayload, sessionPayload] = await Promise.all([
        request<{ items: RecommendationSnapshot[] }>("/recommendation-snapshots?limit=4"),
        request<{ items: Recommendation[] }>(
          `/recommendations?regime=${activeRegimeName}&timeframe=${timeframe}&limit=6`
        ),
        request<{ items: Session[] }>("/sessions?limit=12")
      ]);

      const nextSessionId =
        activeSessionId && sessionPayload.items.some((item) => item.id === activeSessionId)
          ? activeSessionId
          : sessionPayload.items[0]?.id ?? null;

      startTransition(() => {
        setSnapshots(snapshotPayload.items ?? []);
        setRecommendations(recommendationPayload.items ?? []);
        setSessions(sessionPayload.items ?? []);
        setApiHealthy(true);
        setApiMessage(t("apiHealthyMeta"));
        setActiveSessionId(nextSessionId);
      });

      if (nextSessionId) {
        await loadSessionDetail(nextSessionId);
      } else {
        startTransition(() => {
          setSessionDetail(null);
        });
      }
    } catch (error) {
      startTransition(() => {
        setApiHealthy(false);
        setApiMessage(`${t("apiOfflineMeta")} ${toUserMessage(error, t)}`);
        setRecommendations([]);
        setSessions([]);
        setSessionDetail(null);
        setSnapshots([]);
      });
    } finally {
      startTransition(() => {
        setIsRefreshing(false);
      });
    }
  });

  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => {
      void refreshAll();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [refreshAll, timeframe, t]);

  async function startSession(rank: number) {
    startTransition(() => {
      setPendingAction("start-session");
      setActionError("");
    });

    try {
      await request("/sessions", {
        method: "POST",
        body: JSON.stringify({
          marketCode: market,
          rank,
          regimeName: activeRegimeName,
          timeframe,
          startingBalance: Number(balance || 1000000)
        })
      });

      await refreshAll();
    } catch (error) {
      startTransition(() => {
        setActionError(toUserMessage(error, t));
      });
    } finally {
      startTransition(() => {
        setPendingAction("");
      });
    }
  }

  async function runSession() {
    if (!activeSessionId) {
      return;
    }

    startTransition(() => {
      setPendingAction("run-session");
      setActionError("");
    });

    try {
      await request(`/sessions/${activeSessionId}/run`, {
        method: "POST",
        body: JSON.stringify({
          regimeName: activeRegimeName
        })
      });

      await refreshAll();
    } catch (error) {
      startTransition(() => {
        setActionError(toUserMessage(error, t));
      });
    } finally {
      startTransition(() => {
        setPendingAction("");
      });
    }
  }

  async function selectSession(id: number) {
    startTransition(() => {
      setActiveSessionId(id);
    });
    await loadSessionDetail(id);
  }

  return {
    apiHealthy,
    apiMessage,
    isRefreshing,
    isDetailLoading,
    actionError,
    pendingAction,
    opsSnapshot,
    snapshots,
    recommendations,
    sessions,
    activeSessionId,
    sessionDetail,
    refreshAll,
    startSession,
    runSession,
    selectSession
  };
}
