import Log from "./Log";
import Progress from "./Progress";
import Quests from "./Quests";
import Shop from "./Shop";

function Menu(props) {
  const {
    log,
    openedLinks,
    knowledge,
    setKnowledge,
    autos,
    setAutos,
    quests,
    resurfaceArticle,
    setInfo,
    purchasedItems,
    setPurchasedItems,
  } = props;
  const hasOpenedArticle = Object.keys(openedLinks).length > 1;
  const hasOpenQuest = Object.values(quests).some((quest) => !quest.complete);

  return (
    <div id="menu">
      <Progress
        openedLinks={openedLinks}
        knowledge={knowledge}
        autos={autos}
      />

      {hasOpenQuest && (
        <section className="menu-panel quests-panel">
          <h2>Quests</h2>
          <Quests quests={quests} />
        </section>
      )}

      <Shop
        knowledge={knowledge}
        setKnowledge={setKnowledge}
        autos={autos}
        setAutos={setAutos}
        setInfo={setInfo}
        purchasedItems={purchasedItems}
        setPurchasedItems={setPurchasedItems}
      />

      {hasOpenedArticle && (
        <section className="menu-panel history-panel">
          <h2>History</h2>
          <Log log={log} resurfaceArticle={resurfaceArticle} />
        </section>
      )}
    </div>
  );
}
export default Menu;
