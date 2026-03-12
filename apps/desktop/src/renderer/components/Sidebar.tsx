import type { Locale } from "../types";
import type { TFunction } from "./shared";

type AppSection = "overview" | "strategies" | "sessions" | "operations";

type SidebarProps = {
  t: TFunction;
  section: AppSection;
  locale: Locale;
  apiBaseUrl: string;
  timeframe: string;
  market: string;
  balance: string;
  apiHealthy: boolean;
  apiMessage: string;
  isRefreshing: boolean;
  actionError: string;
  opsSnapshot: FstDesktopOpsSnapshot | null;
  recommendations: Array<{ id: number }>;
  sessions: Array<{ id: number }>;
  onSectionChange: (section: AppSection) => void;
  onLocaleChange: (locale: Locale) => void;
  onMarketChange: (market: string) => void;
  onTimeframeChange: (timeframe: string) => void;
  onBalanceChange: (balance: string) => void;
  onRefresh: () => void;
};

export function Sidebar(props: SidebarProps) {
  const {
    t,
    section,
    locale,
    apiBaseUrl,
    timeframe,
    market,
    balance,
    apiHealthy,
    apiMessage,
    isRefreshing,
    actionError,
    opsSnapshot,
    recommendations,
    sessions
  } = props;

  return (
    <aside className="mission-rail">
      <div className="mission-block mission-block-lead">
        <div className="rail-kicker">
          <p className="eyebrow">fst desktop</p>
          <span className={`status-dot ${apiHealthy ? "status-dot-healthy" : "status-dot-danger"}`}></span>
        </div>
        <h1 id="hero-title">{t("heroTitle")}</h1>
        <p id="hero-copy" className="hero-copy">
          {t("heroCopy")}
        </p>
        <div className="signal-stack">
          <div className="signal-card signal-card-primary">
            <span className="meta-label">{t("labelPaperApi")}</span>
            <strong>
              {opsSnapshot?.paperTrader.status === "starting"
                ? t("statusSyncing")
                : apiHealthy
                  ? t("statusHealthy")
                  : t("statusDown")}
            </strong>
            <p>
              {opsSnapshot?.paperTrader.status === "starting"
                ? t("apiStartingMeta")
                : isRefreshing
                  ? t("apiSyncingMeta")
                  : apiMessage}
            </p>
          </div>
          <div className="rail-snapshot-grid">
            <article className="signal-card">
              <span className="meta-label">{t("labelRecommendations")}</span>
              <strong>{recommendations.length}</strong>
              <p>{t("statsRecommendationsCopy")}</p>
            </article>
            <article className="signal-card">
              <span className="meta-label">{t("labelLiveSessions")}</span>
              <strong>{sessions.length}</strong>
              <p>{t("statsSessionsCopy")}</p>
            </article>
          </div>
        </div>
      </div>

      <section className="control-panel">
        <div className="section-head">
          <div>
            <h2>{t("hubNavTitle")}</h2>
            <p className="panel-caption">{t("hubNavCopy")}</p>
          </div>
        </div>
        <div className="hub-nav" role="tablist" aria-label={t("hubNavTitle")}>
          <button
            type="button"
            className={`hub-nav-item ${section === "overview" ? "active" : ""}`}
            onClick={() => props.onSectionChange("overview")}
          >
            <span>{t("navOverview")}</span>
            <strong>{recommendations.length}</strong>
          </button>
          <button
            type="button"
            className={`hub-nav-item ${section === "strategies" ? "active" : ""}`}
            onClick={() => props.onSectionChange("strategies")}
          >
            <span>{t("navStrategies")}</span>
            <strong>{recommendations.length}</strong>
          </button>
          <button
            type="button"
            className={`hub-nav-item ${section === "sessions" ? "active" : ""}`}
            onClick={() => props.onSectionChange("sessions")}
          >
            <span>{t("navSessions")}</span>
            <strong>{sessions.length}</strong>
          </button>
          <button
            type="button"
            className={`hub-nav-item ${section === "operations" ? "active" : ""}`}
            onClick={() => props.onSectionChange("operations")}
          >
            <span>{t("navOperations")}</span>
            <strong>{!opsSnapshot?.tmux.available ? "!" : apiHealthy ? "OK" : "API"}</strong>
          </button>
        </div>
      </section>

      <section className="control-panel">
        <div className="section-head">
          <div>
            <h2 id="trigger-title">{t("settingsTitle")}</h2>
            <p id="trigger-copy" className="panel-caption">
              {t("settingsCopy")}
            </p>
          </div>
        </div>
        <div className="control-stack">
          <div className={`control-status ${actionError ? "control-status-danger" : ""}`}>
            {actionError ? `${t("actionErrorPrefix")}: ${actionError}` : isRefreshing ? t("refreshBusy") : t("syncHealthy")}
          </div>
          <label className="field field-locale">
            <span id="locale-label">{t("localeLabel")}</span>
            <div id="locale-select" className="locale-switch" role="tablist" aria-label={t("localeLabel")}>
              <button
                type="button"
                className={`locale-pill ${locale === "ko" ? "active" : ""}`}
                aria-pressed={locale === "ko"}
                onClick={() => props.onLocaleChange("ko")}
              >
                한국어
              </button>
              <button
                type="button"
                className={`locale-pill ${locale === "en" ? "active" : ""}`}
                aria-pressed={locale === "en"}
                onClick={() => props.onLocaleChange("en")}
              >
                English
              </button>
            </div>
          </label>
          <label className="field">
            <span id="market-label">{t("market")}</span>
            <select
              id="market-select"
              value={market}
              onChange={(event) => props.onMarketChange(event.target.value)}
            >
              <option value="KRW-BTC">KRW-BTC</option>
              <option value="KRW-ETH">KRW-ETH</option>
              <option value="KRW-XRP">KRW-XRP</option>
              <option value="KRW-SOL">KRW-SOL</option>
              <option value="KRW-DOGE">KRW-DOGE</option>
            </select>
          </label>
          <label className="field">
            <span id="timeframe-label">{t("timeframe")}</span>
            <select
              id="timeframe-select"
              value={timeframe}
              onChange={(event) => props.onTimeframeChange(event.target.value)}
            >
              <option value="5m">5m</option>
              <option value="1h">1h</option>
              <option value="1d">1d</option>
            </select>
          </label>
          <label className="field field-balance">
            <span id="balance-label">{t("balance")}</span>
            <input
              id="balance-input"
              type="number"
              min="100000"
              step="100000"
              value={balance}
              onChange={(event) => props.onBalanceChange(event.target.value)}
            />
          </label>
          <button
            id="refresh-button"
            className="ghost-button"
            onClick={props.onRefresh}
            disabled={isRefreshing}
          >
            {isRefreshing ? t("refreshBusy") : t("refresh")}
          </button>
          <div className="signal-card signal-card-dense">
            <span className="meta-label" id="label-paper-api">
              {t("labelApiBase")}
            </span>
            <strong className="runtime-path" id="api-base-url">
              {apiBaseUrl}
            </strong>
            <p id="api-status-meta">
              {!opsSnapshot?.tmux.available
                ? t("tmuxUnavailableMeta")
                : !opsSnapshot.tmux.exists
                  ? t("tmuxMissingMeta", { sessionName: opsSnapshot.tmux.sessionName })
                  : t("tmuxReadyMeta", { sessionName: opsSnapshot.tmux.sessionName })}
            </p>
          </div>
        </div>
      </section>
    </aside>
  );
}
