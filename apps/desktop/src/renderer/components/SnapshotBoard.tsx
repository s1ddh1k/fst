import type { Locale, RecommendationSnapshot } from "../types";
import { formatDateTime, formatPercent, formatSnapshotRules } from "../utils";
import type { TFunction } from "./shared";

type SnapshotBoardProps = {
  t: TFunction;
  locale: Locale;
  snapshots: RecommendationSnapshot[];
};

export function SnapshotBoard(props: SnapshotBoardProps) {
  const { t, locale, snapshots } = props;

  return (
    <section className="snapshot-stage panel-surface">
      <div className="section-head">
        <div>
          <h2 id="snapshots-title">{t("snapshotsTitle")}</h2>
          <p id="snapshots-copy" className="panel-caption">
            {t("snapshotsCopy")}
          </p>
        </div>
      </div>
      <div id="recommendation-snapshots" className="snapshot-list">
        {snapshots.length ? (
          snapshots.map((item) => (
            <article
              className="snapshot-card"
              key={`${item.regimeName}-${item.timeframe}-${item.updatedAt}`}
            >
              <div className="snapshot-head">
                <span className="meta-label">{item.regimeName}</span>
                <span className="snapshot-timeframe">{item.timeframe}</span>
              </div>
              <strong>{item.universeName}</strong>
              <p className="snapshot-primary">
                {t("snapshotLead")} {item.bestStrategyName ?? "-"}
              </p>
              <p>
                {t("snapshotSource")} {item.sourceLabel ?? "-"}
              </p>
              <p>
                {t("snapshotRules")} {formatSnapshotRules(locale, item)}
              </p>
              <p>
                {t("snapshotTrain")} {formatDateTime(locale, item.trainStartAt)} -{" "}
                {formatDateTime(locale, item.trainEndAt)}
              </p>
              <p>
                {t("snapshotTest")} {formatDateTime(locale, item.testStartAt)} -{" "}
                {formatDateTime(locale, item.testEndAt)}
              </p>
              <div className="snapshot-meta">
                <span className="snapshot-pill">
                  {t("snapshotCount")} {item.recommendationCount}
                </span>
                <span className="snapshot-pill">
                  {t("snapshotBest")} {formatPercent(locale, item.bestAvgTestReturn)}
                </span>
                <span className="snapshot-pill">
                  {t("snapshotMdd")} {formatPercent(locale, item.worstAvgTestDrawdown)}
                </span>
              </div>
              <p className="snapshot-foot">
                {t("snapshotGenerated")} {formatDateTime(locale, item.generatedAt)} ·{" "}
                {t("snapshotUpdated")} {formatDateTime(locale, item.updatedAt)}
              </p>
            </article>
          ))
        ) : (
          <div className="empty-panel">
            <p>{t("emptySnapshots")}</p>
          </div>
        )}
      </div>
    </section>
  );
}
