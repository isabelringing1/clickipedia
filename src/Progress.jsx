import { useEffect, useRef } from "react";
import { articlesPerSecond } from "./game/automation.js";

function Progress(props) {
  const {
    visitedCount,
    articleCount,
    knowledge,
    knowledgeLabel = "Knowledge",
    knowledgeOffset = 1,
    articleOffset = 1,
    hideBar = false,
  } = props;
  // The starting article is open from the beginning and does not count.
  const openedCount = Math.max(0, visitedCount - articleOffset);
  const displayedKnowledge = Math.max(0, knowledge - knowledgeOffset);

  const oldKnowledge = useRef(knowledge);
  const delta = knowledge - oldKnowledge.current;

  useEffect(() => {
    oldKnowledge.current = knowledge;
  }, [knowledge]);

  // The total is the number of articles in the Wikipedia snapshot this save
  // is pinned to. It includes articles that no link leads to.
  const progress = articleCount > 0 ? (100 * openedCount) / articleCount : 0;
  const progressText = progress.toFixed(7) + "%";

  return (
    <div className="progress-container">
      <div
        key={knowledge}
        id="knowledge-tween"
        className={delta == 0 ? "" : delta > 0 ? "float-up" : "float-up negative"}
      >
        {delta > 0 ? "+" : "-"} {delta}
      </div>
      <div className="progress-stat-row">
        <span>{knowledgeLabel}</span>
        <strong>{displayedKnowledge.toLocaleString()}</strong>
      </div>
      <div className="progress-stat-row">
        <span>Articles</span>
        <strong>{openedCount.toLocaleString()}</strong>
      </div>
      {!hideBar && (
      <div className="article-progress-tooltip" data-tooltip={progressText}>
        <div
          className="article-progress"
          role="progressbar"
          aria-label="Articles opened"
          aria-valuetext={progressText}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={Math.min(100, progress)}
          tabIndex="0"
        >
          <div
            className="article-progress-value"
            style={{ width: `${Math.min(100, progress)}%` }}
          ></div>
        </div>
      </div>
      )}
    </div>
  );
}

export function AutomationStatus({ autos, automationStatus }) {
  if (autos == 0) {
    return null;
  }
  const rate = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(articlesPerSecond(autos));

  return (
    <div className="automation-status">
      <div className="progress-stat-row">
        <span
          className="hover-tooltip"
          data-tooltip={`${rate} pages/s`}
          tabIndex="0"
        >
          Autos
        </span>
        <strong>{autos.toLocaleString()}</strong>
      </div>
      {automationStatus == "offline" && (
        <div className="progress-text red">
          Link graph unreachable. Retrying...
        </div>
      )}
      {automationStatus == "idle" && (
        <div className="progress-text">No linked articles left to open.</div>
      )}
    </div>
  );
}

export default Progress;
