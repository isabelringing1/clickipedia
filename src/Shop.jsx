import ShopCard from "./ShopCard";
import shopJson from "./Shop.json";

function Shop(props) {
  const {
    knowledge,
    setKnowledge,
    autos,
    setAutos,
    setInfo,
    purchasedItems,
    setPurchasedItems,
  } = props;
  var cards = shopJson["items"];

  const onBuy = (card) => {
    if (card.category == "auto") {
      setAutos(autos + 1);
    } else if (card.category == "cluster") {
      setInfo("ending");
    } else {
      console.error("Did not recognize card category " + card.category);
      return;
    }
    setKnowledge(knowledge - card.cost);
    var newShopDict = { ...purchasedItems };
    newShopDict[card.id] = true;
    if (card.next) {
      var nextCardId = cards[card.next];
      newShopDict[nextCardId] = { complete: false, quest: cards[nextCardId] };
    }
    setPurchasedItems(newShopDict);
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
