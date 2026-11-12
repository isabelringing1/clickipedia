import { useEffect, useRef } from "react";

function Progress(props) {
  const { visitedCount, articleCount, automationStatus, knowledge, autos } =
    props;
  // The starting article is open from the beginning and does not count.
  const openedCount = Math.max(0, visitedCount - 1);
  const displayedKnowledge = Math.max(0, knowledge - 1);

  const oldKnowledge = useRef(knowledge);
  const delta = knowledge - oldKnowledge.current;

  useEffect(() => {
    oldKnowledge.current = knowledge;
  }, [knowledge]);

  // The total is the number of articles in the Wikipedia snapshot this save
  // is pinned to. It includes articles that no link leads to.
  const getProgress = () => {
    var percent = (100 * openedCount) / articleCount;
    return percent.toFixed(7);
  };

  return (
    <div className="progress-container">
      {autos > 0 && (
        <div className="progress-text">
          Auto-opening {autos / 5} pages a second
        </div>
      )}
      {autos > 0 && automationStatus == "offline" && (
        <div className="progress-text red">
          Link graph unreachable. Retrying...
        </div>
      )}
      {autos > 0 && automationStatus == "idle" && (
        <div className="progress-text">No linked articles left to open.</div>
      )}
      <div
        key={knowledge}
        id="knowledge-tween"
        className={delta == 0 ? "" : delta > 0 ? "float-up" : "float-up negative"}
      >
        {delta > 0 ? "+" : "-"} {delta}
      </div>
      <div className="progress-text">Knowledge: {displayedKnowledge}</div>

      <div className="progress-text">
        You've opened {openedCount} articles ({getProgress() + "%"})
      </div>
    </div>
  );
}
export default Progress;
