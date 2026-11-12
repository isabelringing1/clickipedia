import Log from "./Log";
import Progress from "./Progress";
import Quests from "./Quests";
import Shop from "./Shop";
import ScrollRegion from "./ScrollRegion";

function Menu(props) {
  const {
    history,
    rootEntry,
    visitedCount,
    articleCount,
    automationStatus,
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
  const hasOpenedArticle = visitedCount > 1;
  const hasOpenQuest = Object.values(quests).some((quest) => !quest.complete);

  return (
    <div id="menu">
      <Progress
        visitedCount={visitedCount}
        articleCount={articleCount}
        automationStatus={automationStatus}
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
        setAutos={setAutos}
        setInfo={setInfo}
        purchasedItems={purchasedItems}
        setPurchasedItems={setPurchasedItems}
      />

      {hasOpenedArticle && (
        <section className="menu-panel history-panel">
          <h2>History</h2>
          <ScrollRegion className="history-scroll-region">
            <Log
              history={history}
              rootEntry={rootEntry}
              resurfaceArticle={resurfaceArticle}
            />
          </ScrollRegion>
        </section>
      )}
    </div>
  );
}
export default Menu;
