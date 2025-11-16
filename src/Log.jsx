import { formatTopic } from "./util.js";

function Log(props) {
  const { log, resurfaceArticle } = props;
  return (
    <div id="log">
      {[...log].reverse().map((a, i) => {
        if (a[0] == "*") {
          return (
            <div className="log-entry " key={"log-" + i}>
              <a className="log-article red">{formatTopic(a.substring(1))}</a>{" "}
              has already been opened.
            </div>
          );
        } else if (a[0] == "#") {
          if (a == "#HELP") {
            return (
              <div className="log-entry red" key={"log-" + i}>
                Link not valid.
              </div>
            );
          } else if (a == "#QUEST") {
            return (
              <div className="log-entry green" key={"log-" + i}>
                Quest Complete!
              </div>
            );
          }
        } else {
          return (
            <div className="log-entry" key={"log-" + i}>
              &gt; Opened{" "}
              <a className="log-article" onClick={() => resurfaceArticle(i)}>
                {formatTopic(a)}
              </a>
            </div>
          );
        }
      })}
    </div>
  );
}

export default Log;
