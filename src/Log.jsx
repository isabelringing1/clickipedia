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
  const questsByArticle = new Map();
  let precedingArticleSeq = rootEntry.seq;
  for (const entry of history) {
    if (entry.kind === "article") {
      precedingArticleSeq = entry.seq;
    } else if (entry.kind === "quest") {
      const articleSeq = entry.articleSeq ?? precedingArticleSeq;
      const quests = questsByArticle.get(articleSeq) ?? [];
      quests.push(entry);
      questsByArticle.set(articleSeq, quests);
    }
  }
  const visibleHistory = history.filter(
    (entry) =>
      entry.kind === "article" && (showAutos || entry.source !== "auto"),
  );
  return (
    <div id="log">
      {[rootEntry, ...visibleHistory].reverse().map((entry) => {
        const isAuto = entry.source === "auto";
        const quests = questsByArticle.get(entry.seq) ?? [];
        const hasDetails = entry.unlockedTopic || quests.length > 0;
        return (
          <Fragment key={"log-" + entry.seq}>
            <div
              className={`log-entry${hasDetails ? " has-details" : ""}${isAuto ? " auto" : ""}`}
            >
              &gt; Opened{" "}
              <a
                className="log-article"
                onClick={() => resurfaceArticle(entry.seq)}
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
            {quests.map((quest) => (
              <div
                className="log-entry quest-complete-entry purple"
                key={"log-" + quest.seq}
              >
                <strong>{formatTopic(entry.title)}</strong> completed a quest!
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
