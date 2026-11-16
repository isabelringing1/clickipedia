import { memo, useEffect, useRef, useState } from "react";

function Quests(props) {
  const { quests, knowledge, doorHintPurchased, purchaseDoorHint } = props;
  const canPurchaseDoorHint = knowledge - 1 >= 10;

  const openQuests = Object.keys(quests).filter((id) => !quests[id].complete);
  const [visibleQuests, setVisibleQuests] = useState(openQuests);
  const previousCompletion = useRef(
    Object.fromEntries(
      Object.entries(quests).map(([id, entry]) => [id, entry.complete]),
    ),
  );
  const removalTimers = useRef(new Map());

  useEffect(() => {
    const newlyCompleted = Object.entries(quests)
      .filter(
        ([id, entry]) =>
          entry.complete && previousCompletion.current[id] === false,
      )
      .map(([id]) => id);
    previousCompletion.current = Object.fromEntries(
      Object.entries(quests).map(([id, entry]) => [id, entry.complete]),
    );
    setVisibleQuests((current) => {
      const next = current.filter((id) => quests[id]);
      const currentlyOpen = Object.keys(quests).filter(
        (id) => !quests[id].complete,
      );
      for (const id of [...currentlyOpen, ...newlyCompleted]) {
        if (!next.includes(id)) next.push(id);
      }
      return next;
    });
    for (const id of newlyCompleted) {
      if (removalTimers.current.has(id)) continue;
      const timer = setTimeout(() => {
        removalTimers.current.delete(id);
        setVisibleQuests((current) =>
          current.filter((questId) => questId !== id),
        );
      }, 1000);
      removalTimers.current.set(id, timer);
    }
  }, [quests]);

  useEffect(
    () => () => {
      for (const timer of removalTimers.current.values()) {
        clearTimeout(timer);
      }
    },
    [],
  );

  const renderedQuests = [...visibleQuests];
  for (const id of openQuests) {
    if (!renderedQuests.includes(id)) renderedQuests.push(id);
  }
  renderedQuests.sort((left, right) => {
    const leftIsActiveDoor =
      left === "door-quest" && !quests[left].complete;
    const rightIsActiveDoor =
      right === "door-quest" && !quests[right].complete;
    return Number(rightIsActiveDoor) - Number(leftIsActiveDoor);
  });
  if (renderedQuests.length === 0) {
    return null;
  }

  return (
    <section className="menu-panel quests-panel">
      <h2>Quests</h2>
      <div className="quests">
        {renderedQuests.map((id) => {
          const entry = quests[id];
          return (
            <div
              className={`quest${entry.quest.id === "door-quest" ? " door-quest" : ""}${entry.complete ? " completing" : ""}`}
              key={id}
            >
              <div className="quest-text">
                <div className="quest-highlight quest-text">New Quest!</div>{" "}
                <div className="quest-text">
                  {entry.quest.id === "door-quest" ? (
                    <>
                      Find the article for <strong>Door</strong>.
                    </>
                  ) : (
                    entry.quest.desc
                  )}
                </div>
              </div>
              {entry.quest.id === "door-quest" && (
                <div
                  className={`quest-text quest-hint${!doorHintPurchased && !canPurchaseDoorHint ? " unavailable" : ""}`}
                >
                  {doorHintPurchased ? (
                    <>Hint: House, Bathroom, Gate, Window.</>
                  ) : (
                    <button
                      type="button"
                      disabled={!canPurchaseDoorHint}
                      onClick={purchaseDoorHint}
                    >
                      Show Hint: -10 Knowledge
                    </button>
                  )}
                </div>
              )}
              <div className="quest-text">
                Reward:{" "}
                {entry.quest.rewardLabel ??
                  `${entry.quest.reward} Knowledge`}
              </div>
              {entry.complete && (
                <div className="quest-complete-check" aria-hidden="true">
                  <span className="quest-complete-mark"></span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default memo(Quests);
