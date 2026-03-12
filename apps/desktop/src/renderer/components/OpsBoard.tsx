import type { DictionaryKey, Locale } from "../types";
import { formatDateTime } from "../utils";
import type { TFunction } from "./shared";

type OpsBoardProps = {
  t: TFunction;
  locale: Locale;
  apiHealthy: boolean;
  apiMessage: string;
  opsSnapshot: FstDesktopOpsSnapshot | null;
};

export function OpsBoard(props: OpsBoardProps) {
  const { t, locale, apiHealthy, apiMessage, opsSnapshot } = props;

  return (
    <section className="ops-stage panel-surface">
      <div className="section-head">
        <div>
          <h2 id="ops-title">{t("opsTitle")}</h2>
          <p id="generated-at-label" className="panel-caption">
            {t("generatedAt", { value: formatDateTime(locale, opsSnapshot?.generatedAt) })}
          </p>
        </div>
      </div>
      <div className="ops-columns">
        <div className="ops-panel">
          <h3 id="ops-windows-title">{t("opsWindowsTitle")}</h3>
          <div id="tmux-windows" className="chip-row">
            {opsSnapshot?.tmux.windows?.length ? (
              opsSnapshot.tmux.windows.map((item) => (
                <span className="window-chip" key={item}>
                  {item}
                </span>
              ))
            ) : (
              <div className="empty-panel">
                <p>{opsSnapshot?.tmux.available ? t("tmuxMissingBody") : t("tmuxUnavailableBody")}</p>
              </div>
            )}
          </div>
        </div>
        <div className="ops-panel">
          <h3 id="ops-runbook-title">{t("opsRunbookTitle")}</h3>
          <div id="runbook-list" className="runbook-list">
            {opsSnapshot?.runbook.map((item) => (
              <article className="runbook-item" key={item.command}>
                <strong>{t(`runbook_${item.key}` as DictionaryKey)}</strong>
                <code>{item.command}</code>
              </article>
            ))}
          </div>
        </div>
      </div>
      <div
        id="api-banner"
        className={`api-banner ${apiHealthy ? "api-banner-success" : "api-banner-danger"}`}
      >
        {apiHealthy ? t("apiHealthyBanner") : t("apiDownBanner", { message: apiMessage })}
      </div>
    </section>
  );
}
