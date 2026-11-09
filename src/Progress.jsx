import { useState, useEffect } from "react";

function Progress(props) {
  const { openedLinks, knowledge, autos } = props;
  const openedCount = Math.max(0, Object.keys(openedLinks).length - 1);
  const displayedKnowledge = Math.max(0, knowledge - 1);

  const [oldKnowledge, setOldKnowledge] = useState(knowledge);
  const [delta, setDelta] = useState(0);

  useEffect(() => {
    var delta = knowledge - oldKnowledge;
    if (delta != 0) {
      setDelta(delta);
      setOldKnowledge(knowledge);
      var tween = document.getElementById("knowledge-tween");
      tween.classList.remove("float-up");
      void tween.offsetWidth;
      tween.classList.add("float-up");
    }
  }, [knowledge]);

  const getProgress = () => {
    var total = 7068811;
    var percent = (100 * openedCount) / total;
    return percent.toFixed(7);
  };

  return (
    <div className="progress-container">
      {autos > 0 && (
        <div className="progress-text">
          Auto-opening {autos / 5} pages a second
        </div>
      )}
      <div id="knowledge-tween" className={delta > 0 ? "" : " negative"}>
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
