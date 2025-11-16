import { useState, useEffect, useRef } from "react";
import { useSound } from "use-sound";
import { SpinnerCircularFixed } from "spinners-react";
import { ResizableBox } from "react-resizable";

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

  const [content, setContent] = useState(null);
  const [summary, setSummary] = useState(null);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);

  const [posTop, setPosTop] = useState(null);
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
    console.log(e.target);
    if (e.target.closest(".react-resizable-handle")) {
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
  if (!ready) {
    cn += " loading";
  }
  cn += isCondensed ? " condensed" : " full";

  var articleStyle = {
    top: posTop + "px",
    left: posLeft + "px",
    zIndex: isCondensed ? id : 1000000,
  };

  const posReady = () => {
    return id == 0 || posTop;
  };

  return (
    posReady() && (
      <ResizableBox
        className={cn}
        id={"article-" + id}
        style={id == 0 ? {} : articleStyle}
        onClick={onArticleClicked}
        onMouseDown={startDrag}
        width={1000}
        height={1000}
        minConstraints={[400, 200]}
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

        {!ready && (
          <SpinnerCircularFixed
            thickness={150}
            style={{ paddingTop: "1vh" }}
            color={"#8d8d8dff"}
            secondaryColor={"#d5d5d5ff"}
          />
        )}
        {ready && !isCondensed && (
          <div
            className="article-content"
            id={"article-content-" + id}
            dangerouslySetInnerHTML={{ __html: content }}
            style={{ lineHeight: 1.66 }}
          />
        )}
        {ready && isCondensed && (
          <div
            className="article-content condensed"
            id={"article-content-" + id}
            dangerouslySetInnerHTML={{ __html: summary }}
          ></div>
        )}
      </ResizableBox>
    )
  );
}

export default Article;
