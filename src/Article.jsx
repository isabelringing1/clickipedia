import { useState, useEffect, useRef } from "react";
import { useSound } from "use-sound";
import {
  formatTopic,
  fetchWikiPage,
  fetchAllLinksForPage,
  fetchWikiSummary,
  fetchArticleCategories,
} from "./util.js";
import clickSound from "/Click_1.wav";

function Article(props) {
  var {
    topic,
    id,
    linksToCheck,
    isCurrent,
    resurfaceArticle,
    hasSeenArticle,
    processInvalidArticle,
    processNewArticle,
    processSeenArticle,
    checkForQuest,
    processSelfLink,
  } = props;
  const [content, setContent] = useState("");
  const [summary, setSummary] = useState("");
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  const [posTop, setPosTop] = useState(0);
  const [posLeft, setPosLeft] = useState(0);
  const [showHighlight, setShowHighlight] = useState(false);
  const dragTop = useRef(null);
  const dragLeft = useState(null);

  var isCondensed = !isCurrent && id != 0;
  const [playSound] = useSound(clickSound);

  useEffect(() => {
    if (!posTop && id > 0) {
      setPosTop(Math.random() * (window.innerHeight / 2));
      setPosLeft((Math.random() * window.innerWidth) / 2);
    }
  }, []);

  useEffect(() => {
    async function getLinks() {
      setLoading(true);
      var content = await fetchWikiPage(topic, id != 0);
      var summary = await fetchWikiSummary(topic);
      var categories = await fetchArticleCategories(topic);
      setContent(content);
      setSummary(summary);
      setCategories(categories);
      var success = checkForQuest(categories, id);
      if (success) {
        setShowHighlight(true);
      }
      setLoading(false);
      setReady(true);
      var links = await fetchAllLinksForPage(topic);
      linksToCheck.current.push(...links);
    }
    getLinks();
  }, [topic]);

  const onArticleClicked = (e) => {
    e.preventDefault();

    if (isCondensed) {
      resurfaceArticle(id);
      console.log("resurfacing " + id);
    }
    const link = e.target.closest("a");
    //console.log(link);

    if (!link) return;
    playSound();

    if (link.className.includes("mw-selflink-fragment")) {
      console.log("Self Link");
      processSelfLink();
      return;
    }
    if (link.className.includes("#cite-note")) {
      console.log("Citation");
      processInvalidArticle();
      return;
    }

    var href = link.getAttribute("href");

    if (
      href.startsWith("./Wikipedia:") ||
      href.startsWith("./Help:") ||
      href.startsWith("./File:") ||
      href.startsWith("./Special:")
    ) {
      console.log("Meta link: " + href);
      processInvalidArticle();
      return;
    }
    href = href.split("#")[0];

    if (href && href.startsWith("./")) {
      var newPage = decodeURIComponent(href.replace("./", ""));

      if (!hasSeenArticle(newPage)) {
        processNewArticle(newPage);
      } else {
        processSeenArticle(newPage);
      }
    }
  };

  const startDrag = (e) => {
    if (id == 0) {
      return;
    }

    dragTop.current = e.clientY;
    dragLeft.current = e.clientX;
    document.onmouseup = closeDragElement;
    document.onmousemove = articleDragged;
  };

  const closeDragElement = () => {
    document.onmouseup = null;
    document.onmousemove = null;
  };

  const articleDragged = (e) => {
    if (id == 0) {
      return;
    }
    e.preventDefault();
    // calculate the new cursor position:
    var leftDelta = dragLeft.current - e.clientX;
    var topDelta = dragTop.current - e.clientY;

    // set the element's new position:
    setPosTop(posTop - topDelta);
    setPosLeft(posLeft - leftDelta);
  };

  var cn = "article " + topic;
  if (isCurrent) {
    cn += " current";
  }
  if (showHighlight) {
    cn += " highlight";
  }
  cn += isCondensed ? " condensed" : " full";

  var articleStyle = {
    top: posTop + "px",
    left: posLeft + "px",
    zIndex: isCondensed ? id : 1000000,
  };

  return (
    ready && (
      <div
        className={cn}
        id={"article-" + id}
        style={id == 0 ? {} : articleStyle}
        onClick={onArticleClicked}
        onMouseDown={startDrag}
      >
        <div
          className={
            "article-header " + (isCondensed ? "condensed-header" : "")
          }
          id={"article-header-" + id}
        >
          {isCondensed && <div className={"expand-text"}>Click to expand</div>}
          {formatTopic(topic)}
        </div>

        {loading && <p>Loading...</p>}
        {!isCondensed && (
          <div
            dangerouslySetInnerHTML={{ __html: content }}
            style={{ lineHeight: 1.66 }}
          />
        )}
        {isCondensed && (
          <div
            className="condensed"
            dangerouslySetInnerHTML={{ __html: summary }}
          ></div>
        )}
      </div>
    )
  );
}

export default Article;
