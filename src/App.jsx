import { useState, useEffect, useRef, useCallback } from "react";
import { SpinnerCircularFixed } from "spinners-react";
import questsJson from "./quests.json";

import Article from "./Article";
import Menu from "./Menu";
import Logo from "/Logo.png";
import Debug from "./Debug";
import Error from "./Error";
import Info from "./Info";

import { evictWikiPage, formatTopic } from "./util.js";
import { AutomationRunner } from "./game/automation.js";
import { BootError, bootGame } from "./game/boot.js";
import { TitleFeed } from "./game/titleFeed.js";
import { Checkpointer } from "./save/checkpointer.js";
import { SaveError } from "./save/saveFormat.js";
import { GraphError } from "./wikiGraph/client.js";

import "./style/App.css";
import "./style/Wikipedia.css";
import "./style/ReactResizable.css";

const questList = questsJson["quests"];
const LEGACY_SAVE_KEY = "clickipedia";
// Article popups kept on screen; older ones remain in History. Dormant
// windows are deliberately few because every large Wikipedia article already
// gives the browser thousands of DOM nodes to manage.
const MAX_POPUPS = 16;
const MAX_PLAYER_TRAIL = 200;
const AUTOMATION_UI_INTERVAL_MS = 250;
// Title lookup is allowed one new metadata download per second, so matching
// the reveal cadence to it produces an even stream instead of a four-window
// burst followed by gaps.
const TITLE_WINDOW_INTERVAL_MS = 1000;

const isWholeCount = (value) => Number.isInteger(value) && value >= 0;
const isAnything = () => true;

// Saved quests keep a copy of their definition; prefer the current one.
function refreshQuests(quests) {
  return Object.fromEntries(
    Object.entries(quests).map(([id, entry]) => {
      const latestQuest = questList.find((quest) => quest.id == id);
      return [id, latestQuest ? { ...entry, quest: latestQuest } : entry];
    }),
  );
}

function describeBootError(error) {
  if (error instanceof BootError || error instanceof SaveError) {
    return error.message;
  }
  if (error instanceof GraphError) {
    if (error.code === "network" || error.code === "http") {
      return "Could not load the Wikipedia link graph. Check your connection and try again.";
    }
    return error.message;
  }
  return "Something went wrong while starting the game.";
}

function App() {
  const [boot, setBoot] = useState({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    bootGame().then(
      (session) => {
        session.game.quests = refreshQuests(session.game.quests);
        if (!cancelled) {
          setBoot({ status: "ready", session });
        }
      },
      (error) => {
        console.error("Could not start the game:", error);
        if (!cancelled) {
          setBoot({ status: "error", error });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (boot.status === "ready") {
    return <Game session={boot.session} />;
  }

  const error = boot.status === "error" ? boot.error : null;
  // Only a save that cannot be read is worth erasing; a network problem is
  // not fixed by throwing progress away.
  const store = error instanceof SaveError ? error.store : null;

  return (
    <div id="content">
      <div className="boot-screen">
        <img src={Logo} className="boot-logo" alt="Clickipedia" />
        {error == null && (
          <SpinnerCircularFixed
            thickness={150}
            color={"#8d8d8dff"}
            secondaryColor={"#d5d5d5ff"}
          />
        )}
        {error != null && (
          <>
            <div className="boot-message">{describeBootError(error)}</div>
            <div className="info-actions">
              <button
                className="info-action"
                onClick={() => {
                  setBoot({ status: "loading" });
                  setAttempt(attempt + 1);
                }}
              >
                Try again
              </button>
              {store && (
                <button
                  className="reset-button"
                  onClick={async () => {
                    if (
                      window.confirm(
                        "Erase the saved game and start over? This cannot be undone.",
                      )
                    ) {
                      await store.clear();
                      location.reload();
                    }
                  }}
                >
                  Reset Game
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Mirrors one field of the save's game state into React. The save object is
// the source of truth: updates apply to it synchronously, so rapid updates
// from automation and clicks never work from a stale value, and a checkpoint
// always sees current data.
function useGameField(session, checkpointer, field, isValid = isAnything) {
  const [value, setValue] = useState(session.game[field]);
  const set = useCallback(
    (update) => {
      const game = session.game;
      const next = typeof update === "function" ? update(game[field]) : update;
      if (Object.is(next, game[field])) {
        return;
      }
      if (!isValid(next)) {
        console.error(`Ignored invalid value for ${field}:`, next);
        return;
      }
      game[field] = next;
      setValue(next);
      checkpointer.markDirty();
    },
    [session, checkpointer, field, isValid],
  );
  // Automation mutates the live save immediately, then calls this at a
  // slower display cadence. Saves stay exact without making React repaint for
  // every crawler batch.
  const sync = useCallback(() => {
    setValue(session.game[field]);
  }, [session, field]);
  return [value, set, sync];
}

function Game({ session }) {
  const [checkpointer] = useState(
    () => new Checkpointer({ save: () => session.save() }),
  );
  const [rootEntry] = useState(() => ({
    seq: 0,
    kind: "article",
    ordinal: session.startArticle.ordinal,
    title: session.startArticle.title,
    spawn: 0,
  }));

  const [knowledge, setKnowledge, syncKnowledge] = useGameField(
    session,
    checkpointer,
    "knowledge",
    Number.isFinite,
  );
  const [autos, setAutos] = useGameField(
    session,
    checkpointer,
    "autos",
    isWholeCount,
  );
  const [quests, setQuests] = useGameField(session, checkpointer, "quests");
  const [purchasedItems, setPurchasedItems] = useGameField(
    session,
    checkpointer,
    "purchasedItems",
  );
  const [history, setHistory] = useState(session.game.history);
  const [visitedCount, setVisitedCount] = useState(session.visitedCount);
  const [automationStatus, setAutomationStatus] = useState("running");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // Articles are identified by their history sequence number; 0 is the
  // starting article, which is always present.
  const [currentArticle, setCurrentArticle] = useState(() => {
    const articles = session.game.history.filter(
      (entry) => entry.kind == "article",
    );
    return articles.length > 0 ? articles[articles.length - 1].seq : 0;
  });
  const [closedArticles, setClosedArticles] = useState(() => new Set());

  const currentArticleRef = useRef(currentArticle);
  const closedArticlesRef = useRef(closedArticles);
  const playerArticleHistory = useRef([0, currentArticle]);
  const automationUiTimer = useRef(null);

  const selectArticle = useCallback((seq) => {
    currentArticleRef.current = seq;
    setCurrentArticle(seq);
  }, []);

  // Adds entries to the bounded history, keeping the article being read.
  const pushHistory = useCallback(
    (items) => {
      const added = session.addHistory(items, currentArticleRef.current);
      const live = new Set(session.game.history.map((entry) => entry.seq));
      live.add(0);
      playerArticleHistory.current = playerArticleHistory.current
        .filter((seq) => live.has(seq))
        .slice(-MAX_PLAYER_TRAIL);
      setClosedArticles((closed) => {
        const kept = [...closed].filter((seq) => live.has(seq));
        const next = kept.length == closed.size ? closed : new Set(kept);
        closedArticlesRef.current = next;
        return next;
      });
      setHistory(session.game.history);
      checkpointer.markDirty();
      return added;
    },
    [session, checkpointer],
  );

  useEffect(() => {
    setQuests((current) => {
      for (const quest of questList) {
        if (quest.trigger <= knowledge && !current[quest.id]) {
          return { ...current, [quest.id]: { complete: false, quest: quest } };
        }
      }
      return current;
    });
  }, [knowledge, setQuests]);

  // Automation: open articles by following links in the stored graph.
  useEffect(() => {
    const titles = new TitleFeed({
      lookup: (ordinal) => session.titleOf(ordinal),
      shardOf: (ordinal) => session.graph.metadataShardOf(ordinal),
      isShardCached: (shard) => session.graph.isMetadataShardCached(shard),
      deliveryIntervalMs: TITLE_WINDOW_INTERVAL_MS,
      onTitles: (found) =>
        pushHistory(found.map((entry) => ({ kind: "article", ...entry }))),
    });
    const flushUi = () => {
      automationUiTimer.current = null;
      syncKnowledge();
      setVisitedCount(session.visitedCount);
    };
    const scheduleUi = () => {
      if (automationUiTimer.current === null) {
        automationUiTimer.current = setTimeout(flushUi, AUTOMATION_UI_INTERVAL_MS);
      }
    };
    const runner = new AutomationRunner({
      crawler: session.crawler,
      automation: session.state.automation,
      getAutos: () => session.game.autos,
      onOpened: (ordinals) => {
        // The save is updated synchronously; only its React mirror is
        // throttled. Hiding or closing the page therefore cannot lose opens.
        session.game.knowledge += ordinals.length;
        checkpointer.markDirty();
        scheduleUi();
        titles.push(ordinals);
      },
      onStatus: setAutomationStatus,
    });
    runner.start();
    return () => {
      runner.stop();
      titles.stop();
      if (automationUiTimer.current !== null) {
        clearTimeout(automationUiTimer.current);
        automationUiTimer.current = null;
      }
    };
  }, [session, checkpointer, pushHistory, syncKnowledge]);

  // Save when the page is hidden or closed; other saves are debounced.
  useEffect(() => {
    const flush = () => {
      checkpointer.flush();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState == "hidden") {
        flush();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flush);
    };
  }, [checkpointer]);

  const reset = async () => {
    if (
      !window.confirm("Erase all progress and start over? This cannot be undone.")
    ) {
      return;
    }
    await checkpointer.dispose();
    await session.store.clear();
    localStorage.removeItem(LEGACY_SAVE_KEY);
    location.reload();
  };

  const exportSave = () => {
    const text = session.exportText();
    const url = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `clickipedia-save-${session.snapshotId}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Resolves to a message when the file cannot be used.
  const importSave = async (file) => {
    let record;
    try {
      record = await session.prepareImport(await file.text());
    } catch (importError) {
      console.error("Could not import the save:", importError);
      if (importError instanceof SaveError) {
        return importError.message;
      }
      if (importError instanceof GraphError && !importError.transient) {
        return "That save uses a Wikipedia snapshot that is not available here.";
      }
      return "Could not check that save. Check your connection and try again.";
    }
    if (
      !window.confirm(
        "Replace your current game with the imported save? This cannot be undone.",
      )
    ) {
      return null;
    }
    await checkpointer.dispose();
    await session.store.write(record);
    location.reload();
    return null;
  };

  const resurfaceArticle = useCallback((id) => {
    setClosedArticles((closed) => {
      if (!closed.has(id)) {
        return closed;
      }
      const nextClosed = new Set(closed);
      nextClosed.delete(id);
      closedArticlesRef.current = nextClosed;
      return nextClosed;
    });
    playerArticleHistory.current.push(id);
    selectArticle(id);
  }, [selectArticle]);

  const closeArticle = useCallback((id, topic) => {
    evictWikiPage(topic);
    const nextClosed = new Set(closedArticlesRef.current).add(id);
    closedArticlesRef.current = nextClosed;
    setClosedArticles(nextClosed);
    playerArticleHistory.current = playerArticleHistory.current.filter(
      (articleId) => articleId != id,
    );

    if (id == currentArticleRef.current) {
      const previousArticle = [...playerArticleHistory.current]
        .reverse()
        .find((articleId) => !nextClosed.has(articleId));
      selectArticle(previousArticle ?? 0);
    }
  }, [selectArticle]);

  const processSelfLink = useCallback(() => {
    setError("Link leads to current article.");
  }, []);
  const processInvalidArticle = useCallback(() => {
    setError("Non-article link clicked.");
  }, []);

  // The player followed a link to `title` from the article `fromOrdinal`.
  const openLink = useCallback(async (title, fromOrdinal) => {
    let result;
    try {
      result = await session.openLink(title, fromOrdinal);
    } catch (linkError) {
      if (!(linkError instanceof GraphError)) {
        throw linkError;
      }
      console.error("Could not resolve the link:", linkError);
      setError("Link graph unreachable. Try again.");
      return;
    }

    if (result.status == "missing") {
      setError("Article is not in this snapshot.");
    } else if (result.status == "self") {
      processSelfLink();
    } else if (result.status == "seen") {
      setError("Already opened " + formatTopic(result.title) + "!");
    } else {
      setKnowledge((current) => current + 1);
      setVisitedCount(session.visitedCount);
      const [entry] = pushHistory([
        { kind: "article", ordinal: result.ordinal, title: result.title },
      ]);
      playerArticleHistory.current.push(entry.seq);
      selectArticle(entry.seq);
    }
  }, [session, setKnowledge, pushHistory, selectArticle, processSelfLink]);

  const checkForQuest = useCallback((categories) => {
    const current = session.game.quests;
    for (const id of Object.keys(current)) {
      const questEntry = current[id];
      if (questEntry.complete) {
        continue;
      }
      const latestQuest =
        questList.find((quest) => quest.id == questEntry.quest.id) ??
        questEntry.quest;

      if (categories.includes(latestQuest.category)) {
        setQuests({ ...current, [id]: { ...questEntry, complete: true } });
        setKnowledge((value) => value + latestQuest.reward);
        console.log("Quest complete: " + questEntry.quest.id);
        pushHistory([{ kind: "quest" }]);
        return true;
      }
    }
    return false;
  }, [session, setQuests, setKnowledge, pushHistory]);

  const articles = history.filter((entry) => entry.kind == "article");
  const recentArticles = new Set(
    articles.slice(-MAX_POPUPS).map((entry) => entry.seq),
  );

  return (
    <div id="content">
      <Debug autos={autos} setAutos={setAutos} />
      <Info
        info={info}
        setInfo={setInfo}
        reset={reset}
        exportSave={exportSave}
        importSave={importSave}
        snapshot={session.graph.manifest}
        savesPersist={session.store.persistent}
      />
      <Error message={error} setMessage={setError} />

      <div className="game-shell">
        <div className="game-header">
          <button
            className="info-button"
            onClick={() => {
              setInfo("info");
            }}
            aria-label="About Clickipedia"
          >
            ?
          </button>
          <img src={Logo} className="game-logo" alt="Clickipedia" />
        </div>

        <main className="game-stage" id="game-stage">
          {[rootEntry, ...articles].map((entry) => {
            const id = entry.seq;
            if (
              closedArticles.has(id) ||
              (id != 0 && id != currentArticle && !recentArticles.has(id))
            ) {
              //don't render more than 50
              return null;
            }
            return (
              <Article
                isCurrent={id == currentArticle && id != 0}
                topic={entry.title}
                ordinal={entry.ordinal}
                key={"article-" + id}
                id={id}
                spawnIndex={entry.spawn}
                stackIndex={id}
                resurfaceArticle={resurfaceArticle}
                closeArticle={closeArticle}
                processInvalidArticle={processInvalidArticle}
                openLink={openLink}
                checkForQuest={checkForQuest}
                processSelfLink={processSelfLink}
              />
            );
          })}
        </main>

        <Menu
          history={history}
          rootEntry={rootEntry}
          visitedCount={visitedCount}
          articleCount={session.articleCount}
          automationStatus={automationStatus}
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
    </div>
  );
}

export default App;
