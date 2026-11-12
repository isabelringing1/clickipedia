import { useRef, useState } from "react";

// "20261001" -> "2026-10-01"
function formatDumpDate(dumpDate) {
  return /^\d{8}$/.test(dumpDate)
    ? `${dumpDate.slice(0, 4)}-${dumpDate.slice(4, 6)}-${dumpDate.slice(6)}`
    : dumpDate;
}

function Info(props) {
  const {
    info,
    setInfo,
    reset,
    exportSave,
    importSave,
    snapshot,
    savesPersist,
  } = props;
  const fileInput = useRef(null);
  const [notice, setNotice] = useState("");

  const onFileChosen = async (e) => {
    const file = e.target.files[0];
    // Allow choosing the same file again after a failed attempt.
    e.target.value = "";
    if (!file) {
      return;
    }
    setNotice("");
    const problem = await importSave(file);
    if (problem) {
      setNotice(problem);
    }
  };

  var infoHtml = (
    <div className="info-div">
      <div className="info-text">
        Can you open every article on Wikipedia?
        <br />
        Probably not. Why don't you try, anyway?
      </div>
      <div
        className="info-text"
        style={{ paddingTop: "1vh", color: "rgb(0, 0, 0, 0.75)" }}
      >
        <i>
          This game is in active development and will update periodically with
          improvements. Thanks for playing!
        </i>
      </div>
      <div className="info-text info-note">
        Your game uses the links of English Wikipedia as of{" "}
        {formatDumpDate(snapshot.dumpDate)} (
        {snapshot.counts.articles.toLocaleString()} articles). Progress is saved
        in this browser.
      </div>
      {!savesPersist && (
        <div className="info-text info-note red">
          This browser is not keeping saves. Export your save to keep your
          progress.
        </div>
      )}
      {notice != "" && <div className="info-text info-note red">{notice}</div>}
      <div className="info-actions">
        <button className="info-action" onClick={exportSave}>
          Export Save
        </button>
        <button
          className="info-action"
          onClick={() => fileInput.current.click()}
        >
          Import Save
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={onFileChosen}
        />
        <button className="reset-button" onClick={reset}>
          Reset Game
        </button>
      </div>
    </div>
  );

  var endingHtml = (
    <div className="info-div">
      <div className="info-text">Congrats on getting your first cluster!</div>
      <div className="info-text">
        This is as far as the game goes at the moment. Clickipedia was made
        (very quickly) for{" "}
        <a href="https://wikigamejam.org/">WikiGameJam NYC 2025</a>.
      </div>
      <div className="info-text">
        If you have any feedback, please reach out to{" "}
        <a href="mailto:isabelringing1@gmail.com">Isabel</a>. Thanks for
        playing!
      </div>
    </div>
  );

  const onClick = (e) => {
    if (e.target.closest(".info-div")) {
      return;
    }
    setNotice("");
    setInfo("");
  };

  return (
    info != "" && (
      <div className="info-container" onClick={onClick}>
        {info == "info" ? infoHtml : endingHtml}
      </div>
    )
  );
}

export default Info;
