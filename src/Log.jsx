import { memo } from "react";
import { formatTopic } from "./util.js";

// Shows the recent history, newest first. The history is bounded, so this
// lists the latest articles rather than everything ever opened; the starting
// article is always available at the bottom.
function Log(props) {
  const { history, rootEntry, resurfaceArticle } = props;
  return (
    <div id="log">
      {[rootEntry, ...history].reverse().map((entry) => {
        if (entry.kind == "quest") {
          return (
            <div className="log-entry green" key={"log-" + entry.seq}>
              Quest Complete!
            </div>
          );
        }
        return (
          <div className="log-entry" key={"log-" + entry.seq}>
            &gt; Opened{" "}
            <a
              className="log-article"
              onClick={() => resurfaceArticle(entry.seq)}
            >
              {formatTopic(entry.title)}
            </a>
          </div>
        );
      })}
    </div>
  );
}

export default memo(Log);
