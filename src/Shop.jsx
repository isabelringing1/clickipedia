import ShopCard from "./ShopCard";
import shopJson from "./Shop.json";

function Shop(props) {
  const {
    knowledge,
    setKnowledge,
    setAutos,
    setInfo,
    purchasedItems,
    setPurchasedItems,
  } = props;
  var cards = shopJson["items"];

  const onBuy = (card) => {
    // Updates are relative to the current value: automation changes
    // knowledge many times a second, so a value captured at render time may
    // already be out of date when the player clicks.
    if (card.category == "auto") {
      setAutos((current) => current + 1);
    } else if (card.category == "cluster") {
      setInfo("ending");
    } else {
      console.error("Did not recognize card category " + card.category);
      return;
    }
    setKnowledge((current) => current - card.cost);
    setPurchasedItems((current) => {
      var newShopDict = { ...current };
      newShopDict[card.id] = true;
      if (card.next) {
        var nextCardId = cards[card.next];
        newShopDict[nextCardId] = { complete: false, quest: cards[nextCardId] };
      }
      return newShopDict;
    });
  };

  const shouldShowCard = (card) => {
    if (card.trigger > knowledge) {
      console.log("card " + card.id + " has trigger of " + card.trigger);
      return false;
    }
    return (
      !purchasedItems[card.id] && (!card.prev || purchasedItems[card.prev])
    );
  };

  const visibleCards = cards.filter(shouldShowCard);
  if (visibleCards.length == 0) {
    return null;
  }

  return (
    <section className="menu-panel shop-panel">
      <h2>Shop</h2>
      <div className="shop">
        {visibleCards.map((card, i) => {
          return (
            <ShopCard
              key={"shop-card-" + i}
              card={card}
              canBuy={knowledge >= card.cost}
              onBuy={onBuy}
            />
          );
        })}
      </div>
    </section>
  );
}

export default Shop;
