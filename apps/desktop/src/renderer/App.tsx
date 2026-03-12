import { useEffect, useState } from "react";

import {
  OperationsPage,
  SessionBoard,
  StrategiesPage
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
      <main className="terminal-shell">
        <header className="command-bar market-strip">
          <div className="command-bar-copy">
            <p className="eyebrow">fst</p>
            <h1 id="hero-title">{t("heroTitle")}</h1>
            {t("heroCopy") ? <p className="panel-caption">{t("heroCopy")}</p> : null}
          </div>
          <div className="command-bar-context">
            <div className="stage-chips" aria-label={t("stageContextLabel")}>
              <span className="stage-chip">{timeframe}</span>
              <span className="stage-chip">{balance}</span>
              <span className={`stage-chip ${apiHealthy ? "stage-chip-healthy" : "stage-chip-danger"}`}>
                {apiHealthy ? t("statusHealthy") : t("statusDown")}
              </span>
            </div>
            <div className="market-strip-rule" aria-hidden="true">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        </header>

        <section className="terminal-grid">
          <section className="desk-column desk-column-primary">
            <section className="control-panel workspace-bar">
              <div className="workspace-controls">
                <label className="field field-inline">
                  <span>{t("timeframe")}</span>
                  <select value={timeframe} onChange={(event) => setTimeframe(event.target.value)}>
                    <option value="5m">5m</option>
                    <option value="1h">1h</option>
                    <option value="1d">1d</option>
                  </select>
                </label>
                <label className="field field-inline">
                  <span>{t("balance")}</span>
                  <input
                    type="number"
                    min="100000"
                    step="100000"
                    value={balance}
                    onChange={(event) => setBalance(event.target.value)}
                  />
                </label>
                <label className="field field-inline field-inline-locale">
                  <span>{t("localeLabel")}</span>
                  <div className="locale-switch" role="tablist" aria-label={t("localeLabel")}>
                    <button
                      type="button"
                      className={`locale-pill ${locale === "ko" ? "active" : ""}`}
                      aria-pressed={locale === "ko"}
                      onClick={() => setLocale("ko")}
                    >
                      한국어
                    </button>
                    <button
                      type="button"
                      className={`locale-pill ${locale === "en" ? "active" : ""}`}
                      aria-pressed={locale === "en"}
                      onClick={() => setLocale("en")}
                    >
                      English
                    </button>
                  </div>
                </label>
              </div>
              {actionError ? (
                <p className="workspace-error">
                  {t("actionErrorPrefix")}: {actionError}
                </p>
              ) : null}
            </section>
            <StrategiesPage
              t={t}
              locale={locale}
              market={market}
              onMarketChange={setMarket}
              timeframe={timeframe}
              recommendations={recommendations}
              snapshots={snapshots}
              apiHealthy={apiHealthy}
              pendingAction={pendingAction}
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
            <details className="ops-disclosure">
              <summary>{t("opsTitle")}</summary>
              <OperationsPage
                t={t}
                locale={locale}
                apiHealthy={apiHealthy}
                apiMessage={apiMessage}
                opsSnapshot={opsSnapshot}
              />
            </details>
          </section>
        </section>
      </main>
    </div>
  );
}
