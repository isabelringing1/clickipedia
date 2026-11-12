import { useEffect, useState } from "react";

const isLocalHost = () => {
  const host = window.location.hostname;
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
};

function Debug({ autos, setAutos }) {
  const [showDebug, setShowDebug] = useState(false);
  const [autosInput, setAutosInput] = useState(String(autos));
  const enabled = isLocalHost();

  useEffect(() => {
    setAutosInput(String(autos));
  }, [autos]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const onKeyDown = (event) => {
      const target = event.target;
      const isEditing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT");

      if (event.code === "KeyD" && !isEditing && !event.metaKey && !event.ctrlKey) {
        setShowDebug((shown) => !shown);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);

  if (!enabled || !showDebug) {
    return null;
  }

  const applyAutos = (event) => {
    event.preventDefault();
    const nextAutos = Number(autosInput);
    if (Number.isInteger(nextAutos) && nextAutos >= 0) {
      setAutos(nextAutos);
    }
  };

  return (
    <aside className="debug" aria-label="Debug menu">
      <form className="debug-entry" onSubmit={applyAutos}>
        <label htmlFor="debug-autos">Auto openers</label>
        <input
          id="debug-autos"
          type="number"
          min="0"
          step="1"
          value={autosInput}
          onChange={(event) => setAutosInput(event.target.value)}
        />
        <button type="submit">Set</button>
      </form>
    </aside>
  );
}

export default Debug;
