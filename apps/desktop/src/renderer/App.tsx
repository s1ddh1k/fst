import { useEffect, useState } from "react";

import {
  OpsBoard,
  OverviewBand,
  RecommendationBoard,
  SessionBoard,
  Sidebar,
  SnapshotBoard
} from "./components";
import { apiBaseUrl, localeStorageKey } from "./config";
import { useDesktopData } from "./hooks/useDesktopData";
import type { Locale } from "./types";
import { createTranslator } from "./utils";

function getInitialLocale(): Locale {
  const storedLocale = window.localStorage.getItem(localeStorageKey);

  if (storedLocale === "ko" || storedLocale === "en") {
    return storedLocale;
  }

  return "ko";
}

export function App() {
  const [locale, setLocale] = useState<Locale>(getInitialLocale);
  const [market, setMarket] = useState("KRW-BTC");
  const [timeframe, setTimeframe] = useState("5m");
  const [balance, setBalance] = useState("1000000");
  const t = createTranslator(locale);
  const {
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
  } = useDesktopData({
    timeframe,
    market,
    balance,
    t
  });

  useEffect(() => {
    document.documentElement.lang = locale;
    window.localStorage.setItem(localeStorageKey, locale);
  }, [locale]);

  return (
    <div className="app-shell">
      <main className="workspace">
        <Sidebar
          t={t}
          locale={locale}
          apiBaseUrl={apiBaseUrl}
          timeframe={timeframe}
          market={market}
          balance={balance}
          apiHealthy={apiHealthy}
          apiMessage={apiMessage}
          isRefreshing={isRefreshing}
          actionError={actionError}
          opsSnapshot={opsSnapshot}
          onLocaleChange={setLocale}
          onMarketChange={setMarket}
          onTimeframeChange={setTimeframe}
          onBalanceChange={setBalance}
          onRefresh={() => {
            void refreshAll();
          }}
        />

        <section className="live-canvas">
          <OverviewBand
            t={t}
            locale={locale}
            recommendations={recommendations}
            sessions={sessions}
            opsSnapshot={opsSnapshot}
          />

          <OpsBoard
            t={t}
            locale={locale}
            apiHealthy={apiHealthy}
            apiMessage={apiMessage}
            opsSnapshot={opsSnapshot}
          />

          <SnapshotBoard t={t} locale={locale} snapshots={snapshots} />

          <RecommendationBoard
            t={t}
            locale={locale}
            market={market}
            apiHealthy={apiHealthy}
            pendingAction={pendingAction}
            recommendations={recommendations}
            onStartSession={(rank) => {
              void startSession(rank);
            }}
          />

          <SessionBoard
            t={t}
            locale={locale}
            apiHealthy={apiHealthy}
            sessions={sessions}
            activeSessionId={activeSessionId}
            sessionDetail={sessionDetail}
            isDetailLoading={isDetailLoading}
            pendingAction={pendingAction}
            onSelectSession={(id) => {
              void selectSession(id);
            }}
            onRunSession={() => {
              void runSession();
            }}
          />
        </section>
      </main>
    </div>
  );
}
