import { useState, useEffect, useRef } from "react";
import questsJson from "./quests.json";

import Article from "./Article";
import Menu from "./Menu";
import Logo from "/Logo.png";
import Debug from "./Debug";
import Error from "./Error";
import Info from "./Info";

import { formatTopic } from "./util.js";

import "./style/App.css";
import "./style/Wikipedia.css";

function App() {
  const startingArticle = "Incremental_game";
  const [log, setLog] = useState([startingArticle]);
  const [openedLinks, setOpenedLinks] = useState({ startingArticle: true });
  const [autos, setAutos] = useState(0);
  const [quests, setQuests] = useState({});
  const [knowledge, setKnowledge] = useState(1);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [purchasedItems, setPurchasedItems] = useState({});

  const [currentArticle, setCurrentArticle] = useState(0);

  const linksToCheck = useRef([]);
  const ms = useRef(0);
  const questList = questsJson["quests"];

  useEffect(() => {
    for (var i = 0; i < questList.length; i++) {
      var quest = questList[i];
      if (quest.trigger <= knowledge && !quests[quest.id]) {
        var newQuests = { ...quests };
        newQuests[quest.id] = { complete: false, quest: quest };
        setQuests(newQuests);
        break;
      }
    }
  }, [knowledge]);

  useEffect(() => {
    var d = loadData();
    if (d != null) {
      setKnowledge(d.knowledge);
      setAutos(d.autos);
      setOpenedLinks(d.openedLinks);
      setPurchasedItems(d.purchasedItems);
      setQuests(d.quests);
    }
  }, []);

  useEffect(() => {
    saveData();
  }, [knowledge]);

  function saveData() {
    var newPlayerData = {
      knowledge: knowledge,
      autos: autos,
      openedLinks: openedLinks,
      purchasedItems: purchasedItems,
      quests: quests,
    };

    var saveString = JSON.stringify(newPlayerData);

    localStorage.setItem("clickipedia", saveString);
  }

  function loadData() {
    var saveData = localStorage.getItem("clickipedia");
    if (saveData != null) {
      try {
        saveData = JSON.parse(saveData);
      } catch (e) {
        console.log("Could not parse save data: ", e);
        return null;
      }
      return saveData;
    }
    return null;
  }

  const reset = () => {
    localStorage.clear();
    location.reload();
  };

  const shouldFireAuto = () => {
    if (autos == 0) {
      return false;
    }
    var divider = Math.ceil(5000 / autos / 10) * 10; // round to nearest 10
    return ms.current % divider == 0;
  };

  useInterval(() => {
    ms.current += 10;
    if (!shouldFireAuto()) {
      return;
    }
    var newTopics = [];

    var searching = true;
    while (linksToCheck.current.length > 0 && searching) {
      var newTopic = linksToCheck.current[0];
      if (!openedLinks[newTopic]) {
        newTopics.push(newTopic);
        searching = false;
      } else {
      }
      linksToCheck.current = linksToCheck.current.slice(1);
    }

    setLog([...log, ...newTopics]);
    setKnowledge(knowledge + newTopics.length);
    var newOpenedLinks = { ...openedLinks };
    for (var i in newTopics) {
      newOpenedLinks[newTopics[i]] = true;
    }

    setOpenedLinks(newOpenedLinks);
  }, 10);

  function useInterval(callback, delay) {
    const savedCallback = useRef();

    // Remember the latest function.
    useEffect(() => {
      savedCallback.current = callback;
    }, [callback]);

    // Set up the interval.
    useEffect(() => {
      function tick() {
        savedCallback.current();
      }
      if (delay !== null) {
        let id = setInterval(tick, delay);
        return () => clearInterval(id);
      }
    }, [delay]);
  }
  //console.log("rerender app");

  const resurfaceArticle = (id) => {
    setCurrentArticle(id);
  };

  const hasSeenArticle = (topic) => {
    return openedLinks[topic];
  };
  const processSelfLink = () => {
    setError("Link leads to current article.");
  };
  const processInvalidArticle = () => {
    //setLog([...log, "#HELP"]);
    setError("Non-article link clicked.");
  };

  const processNewArticle = (topic) => {
    var newOpenedLinks = { ...openedLinks };
    setLog([...log, topic]);
    newOpenedLinks[topic] = true;
    setKnowledge(knowledge + 1);
    setCurrentArticle(log.length);
    setOpenedLinks(newOpenedLinks);
  };

  const processSeenArticle = (topic) => {
    //setLog([...log, "*" + topic]);
    setError("Already opened " + formatTopic(topic) + "!");
  };

  const checkForQuest = (categories, id) => {
    var openQuests = Object.keys(quests).filter((id) => !quests[id].complete);
    for (var i = 0; i < openQuests.length; i++) {
      var questEntry = quests[openQuests[i]];

      if (categories.includes(questEntry.quest.category)) {
        var newQuests = { ...quests };
        newQuests[questEntry.quest.id].complete = true;
        setQuests(newQuests);
        setKnowledge(knowledge + questEntry.quest.reward);
        console.log("Quest complete: " + questEntry.quest.id);
        setLog([...log, "#QUEST"]);
        return true;
      }
    }
    return false;
  };

  return (
    <div id="content">
      <Debug setAutos={setAutos} setKnowledge={setKnowledge} />
      <Info info={info} setInfo={setInfo} reset={reset} />
      <Error message={error} setMessage={setError} />
      <div className="game-header">
        <img src={Logo} className="game-logo" />
        <button
          className="info-button"
          onClick={() => {
            setInfo("info");
          }}
        >
          ?
        </button>
      </div>
      {log.map((a, i) => {
        console.log(log.length - i, a);
        if (a[0] == "*" || a[0] == "#" || (i > 0 && log.length - i > 50)) {
          //don't render more than 50
          return null;
        }
        return (
          <Article
            isCurrent={i == currentArticle && i != 0}
            topic={a}
            key={"article-" + i}
            id={i}
            linksToCheck={linksToCheck}
            resurfaceArticle={resurfaceArticle}
            hasSeenArticle={hasSeenArticle}
            processInvalidArticle={processInvalidArticle}
            processNewArticle={processNewArticle}
            processSeenArticle={processSeenArticle}
            checkForQuest={checkForQuest}
            processSelfLink={processSelfLink}
          />
        );
      })}
      <Menu
        log={log}
        openedLinks={openedLinks}
        knowledge={knowledge}
        setKnowledge={setKnowledge}
        autos={autos}
        setAutos={setAutos}
        quests={quests}
        resurfaceArticle={resurfaceArticle}
        setInfo={setInfo}
        purchasedItems={purchasedItems}
        setPurchasedItems={setPurchasedItems}
      />
    </div>
  );
}

export default App;
