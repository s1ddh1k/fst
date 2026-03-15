import { startTransition, useEffect, useEffectEvent, useState } from "react";

import { activeRegimeName, apiBaseUrl } from "../config";
import type {
  DictionaryKey,
  Recommendation,
  Session,
  SessionDetailPayload
} from "../types";

type TFunction = (key: DictionaryKey, values?: Record<string, string | number>) => string;

function toUserMessage(error: unknown, t: TFunction) {
  const message = error instanceof Error ? error.message : String(error);

  if (/fetch failed|failed to fetch|networkerror/i.test(message)) {
    return t("connectionError");
  }

  if (/request failed:/i.test(message)) {
    return t("connectionHttpError");
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
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetailPayload | null>(null);
  const [apiHealthy, setApiHealthy] = useState(false);
  const [apiMessage, setApiMessage] = useState("");
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState<"start" | "run" | "">("");

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
      setActionError("");
    });

    try {
      const [recommendationPayload, sessionPayload] = await Promise.all([
        request<{ items: Recommendation[] }>(
          `/recommendations?regime=${activeRegimeName}&timeframe=${timeframe}&limit=5`
        ),
        request<{ items: Session[] }>("/sessions?limit=5")
      ]);

      const nextSessionId =
        activeSessionId && sessionPayload.items.some((item) => item.id === activeSessionId)
          ? activeSessionId
          : sessionPayload.items[0]?.id ?? null;

      startTransition(() => {
        setRecommendations(recommendationPayload.items ?? []);
        setSessions(sessionPayload.items ?? []);
        setApiHealthy(true);
        setApiMessage("");
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
        setApiMessage(toUserMessage(error, t));
        setRecommendations([]);
        setSessions([]);
        setSessionDetail(null);
      });
    }
  });

  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => {
      void refreshAll();
    }, 30000);

    return () => window.clearInterval(timer);
  }, [refreshAll, timeframe, t]);

  async function startSession(rank: number) {
    startTransition(() => {
      setPendingAction("start");
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
      setPendingAction("run");
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
    isDetailLoading,
    actionError,
    pendingAction,
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
