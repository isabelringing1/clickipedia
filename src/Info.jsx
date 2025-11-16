function Info(props) {
  const { info, setInfo, reset } = props;

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
      <button className="reset-button" onClick={reset}>
        Reset Game
      </button>
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
