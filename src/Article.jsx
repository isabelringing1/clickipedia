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

const DRAG_THRESHOLD = 4;

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
  const dragState = useRef(null);
  const dragFrame = useRef(null);
  const suppressClick = useRef(false);

  var isCondensed = !isCurrent && id != 0;
  const [playSound] = useSound(clickSound);

  useEffect(() => {
    if (posTop == null && id > 0) {
      const stage = document.getElementById("game-stage");
      const stageHeight = stage?.clientHeight ?? window.innerHeight;
      const stageWidth = stage?.clientWidth ?? window.innerWidth;
      setPosTop(Math.random() * stageHeight * 0.12);
      setPosLeft(Math.random() * stageWidth * 0.1);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (dragFrame.current != null) {
        cancelAnimationFrame(dragFrame.current);
      }
    };
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

    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }

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

  const updateDragTransform = () => {
    dragFrame.current = null;
    const drag = dragState.current;
    if (!drag || !drag.moved) {
      return;
    }

    const leftDelta = drag.clientX - drag.startX;
    const topDelta = drag.clientY - drag.startY;
    drag.article.style.transform = `translate3d(${leftDelta}px, ${topDelta}px, 0)`;
  };

  const startDrag = (e) => {
    if (id == 0 || e.button != 0) {
      return;
    }

    const article = e.currentTarget.closest(".article");
    if (!article) {
      return;
    }

    suppressClick.current = false;
    dragState.current = {
      article,
      header: e.currentTarget,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      clientX: e.clientX,
      clientY: e.clientY,
      startLeft: posLeft,
      startTop: posTop,
      moved: false,
    };
    article.classList.add("dragging");
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const articleDragged = (e) => {
    const drag = dragState.current;
    if (!drag || e.pointerId != drag.pointerId) {
      return;
    }

    e.preventDefault();
    drag.clientX = e.clientX;
    drag.clientY = e.clientY;

    if (
      !drag.moved &&
      Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >=
        DRAG_THRESHOLD
    ) {
      drag.moved = true;
      suppressClick.current = true;
    }

    if (drag.moved && dragFrame.current == null) {
      dragFrame.current = requestAnimationFrame(updateDragTransform);
    }
  };

  const closeDragElement = (e) => {
    const drag = dragState.current;
    if (!drag || e.pointerId != drag.pointerId) {
      return;
    }

    if (dragFrame.current != null) {
      cancelAnimationFrame(dragFrame.current);
      dragFrame.current = null;
    }

    const endX = e.type === "pointercancel" ? drag.clientX : e.clientX;
    const endY = e.type === "pointercancel" ? drag.clientY : e.clientY;
    const moved =
      drag.moved ||
      Math.hypot(endX - drag.startX, endY - drag.startY) >= DRAG_THRESHOLD;

    if (moved) {
      const nextLeft = drag.startLeft + endX - drag.startX;
      const nextTop = drag.startTop + endY - drag.startY;

      // Update the node before committing React state to avoid a one-frame snap.
      drag.article.style.left = `${nextLeft}px`;
      drag.article.style.top = `${nextTop}px`;
      drag.article.style.transform = "";
      setPosLeft(nextLeft);
      setPosTop(nextTop);

      if (e.type === "pointercancel") {
        suppressClick.current = false;
      } else {
        suppressClick.current = true;
        setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
    }

    drag.article.classList.remove("dragging");
    if (drag.header.hasPointerCapture(drag.pointerId)) {
      drag.header.releasePointerCapture(drag.pointerId);
    }
    dragState.current = null;
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
    return id == 0 || posTop != null;
  };

  return (
    posReady() && (
      <ResizableBox
        className={cn}
        id={"article-" + id}
        style={id == 0 ? {} : articleStyle}
        onClick={onArticleClicked}
        width={1000}
        height={1000}
        minConstraints={[400, 200]}
      >
        <div
          className={
            "article-header " + (isCondensed ? "condensed-header" : "")
          }
          id={"article-header-" + id}
          onPointerDown={startDrag}
          onPointerMove={articleDragged}
          onPointerUp={closeDragElement}
          onPointerCancel={closeDragElement}
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
