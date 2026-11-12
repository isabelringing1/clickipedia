import { memo } from "react";

function Quests(props) {
  const { quests } = props;

  var openQuests = Object.keys(quests).filter((id) => !quests[id].complete);

  return (
    <div className="quests">
      {openQuests.map((id, i) => {
        return (
          <div className="quest" key={"quest-" + i}>
            <div className="quest-text">
              <div className="quest-highlight quest-text">New Quest!</div>{" "}
              <div className="quest-text">{quests[id].quest.desc}</div>
            </div>
            <div className="quest-text">
              Reward: {quests[id].quest.reward} Knowledge
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default memo(Quests);
