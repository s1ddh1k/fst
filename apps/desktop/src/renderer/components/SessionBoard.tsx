import type { Locale, Session, SessionDetailPayload } from "../types";
import { formatDateTime, formatNumber, formatStatus } from "../utils";
import type { TFunction } from "./shared";

type SessionBoardProps = {
  t: TFunction;
  locale: Locale;
  apiHealthy: boolean;
  sessions: Session[];
  activeSessionId: number | null;
  sessionDetail: SessionDetailPayload | null;
  isDetailLoading: boolean;
  pendingAction: string;
  onSelectSession: (id: number) => void;
  onRunSession: () => void;
};

export function SessionBoard(props: SessionBoardProps) {
  const { t, locale, apiHealthy, sessions, activeSessionId, sessionDetail, isDetailLoading, pendingAction } = props;

  return (
    <section className="dossier-grid">
      <section className="sessions-stage panel-surface">
        <div className="section-head">
          <div>
            <h2 id="sessions-title">{t("sessionsTitle")}</h2>
            <p id="sessions-copy" className="panel-caption">
              {t("sessionsCopy")}
            </p>
          </div>
        </div>
        <div id="sessions" className="session-column">
          {sessions.length ? (
            sessions.map((item) => (
              <article
                className={`session-row ${activeSessionId === item.id ? "active" : ""}`}
                key={item.id}
                onClick={() => props.onSelectSession(item.id)}
              >
                <div className="session-topline">
                  <span className="rank-badge">#{item.id}</span>
                  <span className={`status-badge status-${item.status}`}>
                    {formatStatus(locale, item.status)}
                  </span>
                </div>
                <h3>{item.strategyName.replaceAll("-", " ")}</h3>
                <p>{item.marketCode}</p>
                <strong className="session-balance">
                  {formatNumber(locale, item.currentBalance)}
                </strong>
              </article>
            ))
          ) : (
            <div className="empty-panel">
              <p>{apiHealthy ? t("emptySessions") : t("apiSessionsError")}</p>
            </div>
          )}
        </div>
      </section>

      <section className="focus-stage panel-surface">
        <div className="section-head">
          <div>
            <h2 id="session-focus-title">{t("sessionFocusTitle")}</h2>
            <p id="session-focus-copy" className="panel-caption">
              {t("sessionFocusCopy")}
            </p>
          </div>
        </div>
        <div id="session-detail" className="detail-stage">
          {sessionDetail ? (
            <>
              <div className="detail-block">
                <div className="section-head">
                  <h3>{t("sessionTitle", { id: sessionDetail.session.id })}</h3>
                  <button
                    id="run-session-button"
                    className="action-button"
                    onClick={props.onRunSession}
                    disabled={pendingAction !== "" || isDetailLoading}
                  >
                    {pendingAction === "run-session" ? t("runSessionBusy") : t("runSession")}
                  </button>
                </div>
                <div className="detail-grid">
                  <div>
                    <span className="meta-label">{t("status")}</span>
                    <strong className={`status-badge status-${sessionDetail.session.status}`}>
                      {formatStatus(locale, sessionDetail.session.status)}
                    </strong>
                  </div>
                  <div>
                    <span className="meta-label">{t("marketCode")}</span>
                    <strong>{sessionDetail.session.marketCode}</strong>
                  </div>
                </div>
              </div>
              <div className="detail-block">
                <h3>{t("position")}</h3>
                <div className="detail-grid">
                  <div>
                    <span className="meta-label">{t("currentBalance")}</span>
                    <strong>{formatNumber(locale, sessionDetail.session.currentBalance)}</strong>
                  </div>
                  <div>
                    <span className="meta-label">{t("quantity")}</span>
                    <strong>{formatNumber(locale, sessionDetail.position?.quantity)}</strong>
                  </div>
                  <div>
                    <span className="meta-label">{t("markPrice")}</span>
                    <strong>{formatNumber(locale, sessionDetail.position?.markPrice)}</strong>
                  </div>
                  <div>
                    <span className="meta-label">{t("unrealizedPnl")}</span>
                    <strong>{formatNumber(locale, sessionDetail.position?.unrealizedPnl)}</strong>
                  </div>
                </div>
              </div>
              <details className="session-disclosure detail-block">
                <summary>{t("moreInfo")}</summary>
                <div className="detail-grid">
                  <div>
                    <span className="meta-label">{t("strategy")}</span>
                    <strong>{sessionDetail.session.strategyName}</strong>
                  </div>
                  <div>
                    <span className="meta-label">{t("timeframe")}</span>
                    <strong>{sessionDetail.session.timeframe}</strong>
                  </div>
                  <div>
                    <span className="meta-label">{t("avgEntryPrice")}</span>
                    <strong>{formatNumber(locale, sessionDetail.position?.avgEntryPrice)}</strong>
                  </div>
                  <div>
                    <span className="meta-label">{t("realizedPnl")}</span>
                    <strong>{formatNumber(locale, sessionDetail.position?.realizedPnl)}</strong>
                  </div>
                </div>
                <div className="orders orders-compact">
                  {sessionDetail.recentOrders.slice(0, 2).length ? (
                    sessionDetail.recentOrders.slice(0, 2).map((order, index) => (
                      <div className="order-pill" key={`${order.side}-${index}`}>
                        <span>{order.side}</span>
                        <span>{formatNumber(locale, order.executedPrice)}</span>
                      </div>
                    ))
                  ) : (
                    <p>{t("noOrders")}</p>
                  )}
                </div>
                <p className="panel-caption panel-caption-compact">
                  {t("generatedAt", { value: formatDateTime(locale, sessionDetail.session.startedAt) })}
                </p>
              </details>
            </>
          ) : isDetailLoading ? (
            <p id="session-placeholder">{t("sessionDetailLoading")}</p>
          ) : (
            <p id="session-placeholder">
              {apiHealthy ? t("sessionPlaceholder") : t("apiDetailError")}
            </p>
          )}
        </div>
      </section>
    </section>
  );
}
