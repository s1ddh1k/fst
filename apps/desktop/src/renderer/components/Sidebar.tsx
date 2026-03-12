import type { Locale } from "../types";
import type { TFunction } from "./shared";

type SidebarProps = {
  t: TFunction;
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
  onLocaleChange: (locale: Locale) => void;
  onMarketChange: (market: string) => void;
  onTimeframeChange: (timeframe: string) => void;
  onBalanceChange: (balance: string) => void;
  onRefresh: () => void;
};

export function Sidebar(props: SidebarProps) {
  const {
    t,
    locale,
    apiBaseUrl,
    timeframe,
    market,
    balance,
    apiHealthy,
    apiMessage,
    isRefreshing,
    actionError,
    opsSnapshot
  } = props;

  return (
    <aside className="mission-rail">
      <div className="mission-block mission-block-lead">
        <p className="eyebrow">fst desktop</p>
        <h1 id="hero-title">{t("heroTitle")}</h1>
        <p id="hero-copy" className="hero-copy">
          {t("heroCopy")}
        </p>
      </div>

      <div className="signal-stack">
        <article className="signal-card signal-card-primary">
          <span className="meta-label" id="label-tmux-workspace">
            {t("labelTmuxWorkspace")}
          </span>
          <strong id="tmux-status-text">
            {!opsSnapshot?.tmux.available
              ? t("statusTmuxUnavailable")
              : !opsSnapshot.tmux.exists
                ? t("statusTmuxMissing")
                : t("statusTmuxReady")}
          </strong>
          <p id="tmux-status-meta">
            {!opsSnapshot?.tmux.available
              ? t("tmuxUnavailableMeta")
              : !opsSnapshot.tmux.exists
                ? t("tmuxMissingMeta", { sessionName: opsSnapshot.tmux.sessionName })
                : t("tmuxReadyMeta", { sessionName: opsSnapshot.tmux.sessionName })}
          </p>
        </article>
        <article className="signal-card">
          <span className="meta-label" id="label-paper-runtime">
            {t("labelPaperRuntime")}
          </span>
          <strong>
            {opsSnapshot?.paperTrader.managed
              ? t("statusEmbedded")
              : t("statusExternal")}
          </strong>
          <p>
            {opsSnapshot?.paperTrader.managed
              ? opsSnapshot.paperTrader.status === "running"
                ? t("runtimeEmbeddedHealthy")
                : opsSnapshot.paperTrader.status === "starting"
                  ? t("runtimeEmbeddedStarting")
                  : t("runtimeEmbeddedStopped")
              : t("runtimeExternal")}
          </p>
        </article>
        <article className="signal-card">
          <span className="meta-label" id="label-paper-api">
            {t("labelPaperApi")}
          </span>
          <strong id="api-status-text">{apiHealthy ? t("statusHealthy") : t("statusDown")}</strong>
          <p id="api-status-meta">{isRefreshing ? t("apiSyncingMeta") : apiMessage}</p>
        </article>
        <article className="signal-card signal-card-dense">
          <span className="meta-label" id="label-api-base">
            {t("labelApiBase")}
          </span>
          <strong id="api-base-url">{apiBaseUrl}</strong>
          <p>
            <span id="label-active-regime">{t("labelActiveRegime")}</span>{" "}
            <span id="active-regime-label">{`paper-trading-candidate / ${timeframe}`}</span>
          </p>
        </article>
      </div>

      <section className="control-panel">
        <div className="section-head">
          <div>
            <h2 id="trigger-title">{t("triggerTitle")}</h2>
            <p id="trigger-copy" className="panel-caption">
              {t("triggerCopy")}
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
        </div>
      </section>
    </aside>
  );
}
