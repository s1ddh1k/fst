import { OpsBoard } from "./OpsBoard";
import type { Locale } from "../types";
import type { TFunction } from "./shared";

type OperationsPageProps = {
  t: TFunction;
  locale: Locale;
  apiHealthy: boolean;
  apiMessage: string;
  opsSnapshot: FstDesktopOpsSnapshot | null;
};

export function OperationsPage(props: OperationsPageProps) {
  const { t, opsSnapshot } = props;

  return (
    <section className="hub-stage">
      <section className="overview-band overview-band-compact">
        <article className="hero-stat hero-stat-emphasis">
          <span className="meta-label">{t("labelTmuxWorkspace")}</span>
          <strong>
            {!opsSnapshot?.tmux.available
              ? t("statusTmuxUnavailable")
              : !opsSnapshot.tmux.exists
                ? t("statusTmuxMissing")
                : t("statusTmuxReady")}
          </strong>
          <p>
            {!opsSnapshot?.tmux.available
              ? t("tmuxUnavailableMeta")
              : !opsSnapshot.tmux.exists
                ? t("tmuxMissingMeta", { sessionName: opsSnapshot.tmux.sessionName })
                : t("tmuxReadyMeta", { sessionName: opsSnapshot.tmux.sessionName })}
          </p>
        </article>
        <article className="hero-stat">
          <span className="meta-label">{t("labelPaperRuntime")}</span>
          <strong>{opsSnapshot?.paperTrader.status ?? "-"}</strong>
          <p>
            {opsSnapshot?.paperTrader.managed ? t("runtimeEmbeddedHealthy") : t("runtimeExternal")}
          </p>
        </article>
      </section>
      <OpsBoard {...props} />
    </section>
  );
}
