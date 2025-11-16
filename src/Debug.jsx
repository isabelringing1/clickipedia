import { useState, useRef, useEffect } from "react";
function Debug(props) {
  const { setAutos, setKnowledge } = props;

  var [showDebug, setShowDebug] = useState(false);

  const autosRef = useRef();
  const knowledgeRef = useRef();
  const devMode = true;

  useEffect(() => {
    document.addEventListener("keydown", (event) => {
      if (event.code === "KeyD" && devMode) {
        toggleShowDebug();
      }
    });
  }, []);

  const toggleShowDebug = () => {
    setShowDebug((prevShowDebug) => !prevShowDebug);
  };

  return (
    showDebug && (
      <div className="debug">
        <div className="debug-entry">
          <input type="number" ref={autosRef} />{" "}
          <button
            id="set-autos-button"
            onClick={() => {
              setAutos(parseInt(autosRef.current.value));
            }}
          >
            {" "}
            Set Autos{" "}
          </button>
        </div>
        <div className="debug-entry">
          <input type="number" ref={knowledgeRef} />{" "}
          <button
            id="set-knowledge-button"
            onClick={() => {
              setKnowledge(parseInt(knowledgeRef.current.value));
            }}
          >
            {" "}
            Set Knowledge{" "}
          </button>
        </div>
      </div>
    )
  );
}

export default Debug;
