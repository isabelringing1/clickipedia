import { Fragment, memo } from "react";
import { formatTopic } from "./util.js";

// Shows the recent history, newest first. The history is bounded, so this
// lists the latest articles rather than everything ever opened; the starting
// article is always available at the bottom.
function Log(props) {
  const {
    history,
    historyDroppedCount,
    showAutos,
    rootEntry,
    resurfaceArticle,
  } = props;
  const alertsByArticle = new Map();
  let precedingArticleSeq = rootEntry.seq;
  for (const entry of history) {
    if (entry.kind === "article") {
      precedingArticleSeq = entry.seq;
    } else if (entry.kind === "quest" || entry.kind === "door") {
      const articleSeq = entry.articleSeq ?? precedingArticleSeq;
      const alerts = alertsByArticle.get(articleSeq) ?? [];
      alerts.push(entry);
      alertsByArticle.set(articleSeq, alerts);
    }
  }
  const visibleHistory = history.filter(
    (entry) =>
      entry.kind === "reopen" ||
      (entry.kind === "article" &&
        (showAutos ||
          entry.source !== "auto" ||
          alertsByArticle.has(entry.seq))),
  );
  return (
    <div id="log">
      {[rootEntry, ...visibleHistory].reverse().map((entry) => {
        const isAuto = entry.source === "auto";
        const articleSeq =
          entry.kind === "reopen" ? entry.articleSeq : entry.seq;
        const alerts =
          entry.kind === "article"
            ? (alertsByArticle.get(entry.seq) ?? [])
            : [];
        const isReopened = entry.alreadyOpened || entry.kind === "reopen";
        const hasDetails = entry.unlockedTopic || alerts.length > 0;
        return (
          <Fragment key={"log-" + entry.seq}>
            <div
              className={`log-entry${hasDetails ? " has-details" : ""}${isAuto ? " auto" : ""}`}
            >
              {isReopened ? ">>" : ">"} Opened{" "}
              <a
                className="log-article"
                onClick={() => resurfaceArticle(articleSeq)}
              >
                {formatTopic(entry.title)}
              </a>
            </div>
            {entry.unlockedTopic && (
              <div className="log-entry topic-unlock-entry">
                <strong>{formatTopic(entry.title)}</strong> unlocked{" "}
                <strong>{entry.unlockedTopic.label}</strong>!
              </div>
            )}
            {alerts.map((alert) => (
              <div
                className={`log-entry quest-complete-entry${alert.kind === "door" ? " door-unlock-entry" : " purple"}`}
                key={"log-" + alert.seq}
              >
                {alert.kind === "door" ? (
                  <>
                    <strong>Door</strong> is unlocked.
                  </>
                ) : (
                  <>
                    <strong>{formatTopic(entry.title)}</strong> completed a
                    quest!
                  </>
                )}
              </div>
            ))}
          </Fragment>
        );
      })}
      {historyDroppedCount > 0 && (
        <div className="log-entry history-more">
          And {historyDroppedCount.toLocaleString()} more...
        </div>
      )}
    </div>
  );
}

export default memo(Log);
