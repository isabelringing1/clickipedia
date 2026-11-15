import { useState } from "react";
import Log from "./Log";
import { AutomationStatus } from "./Progress";
import Quests from "./Quests";
import Shop from "./Shop";
import ScrollRegion from "./ScrollRegion";

function Menu(props) {
  const {
    history,
    historyDroppedCount,
    rootEntry,
    quests,
    anyBlocked,
    resurfaceArticle,
    leaveRoom,
  } = props;
  const [showAutos, setShowAutos] = useState(false);
  const hasOpenQuest = Object.values(quests).some((quest) => !quest.complete);

  return (
    <div id="menu">
      <button className="leave-room" type="button" onClick={leaveRoom}>
        <span aria-hidden="true">&lt;</span> Leave Room
        {anyBlocked && <span className="room-warning"> !</span>}
      </button>
      <section className="menu-panel history-panel">
        <div className="history-heading">
          <h2>History</h2>
          <label className="history-autos-toggle">
            <input
              type="checkbox"
              checked={showAutos}
              onChange={(event) => setShowAutos(event.target.checked)}
            />
            Show Autos
          </label>
        </div>
        <ScrollRegion className="history-scroll-region">
          <Log
            history={history}
            historyDroppedCount={historyDroppedCount}
            showAutos={showAutos}
            rootEntry={rootEntry}
            resurfaceArticle={resurfaceArticle}
          />
        </ScrollRegion>
      </section>

      {hasOpenQuest && (
        <section className="menu-panel quests-panel">
          <h2>Quests</h2>
          <Quests quests={quests} />
        </section>
      )}
    </div>
  );
}

export function SharedMenu(props) {
  const {
    knowledge,
    autos,
    automationStatus,
    setKnowledge,
    setAutos,
    setInfo,
    purchasedItems,
    setPurchasedItems,
    hidden,
  } = props;

  return (
    <aside className="shared-menu" hidden={hidden}>
      {autos > 0 && (
        <section className="menu-panel auto-panel">
          <AutomationStatus
            autos={autos}
            automationStatus={automationStatus}
          />
        </section>
      )}
      <Shop
        knowledge={knowledge}
        setKnowledge={setKnowledge}
        setAutos={setAutos}
        setInfo={setInfo}
        purchasedItems={purchasedItems}
        setPurchasedItems={setPurchasedItems}
      />
    </aside>
  );
}

export default Menu;
