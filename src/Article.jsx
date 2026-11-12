import { memo, useState, useEffect, useLayoutEffect, useRef } from "react";
import { useSound } from "use-sound";
import { SpinnerCircularFixed } from "spinners-react";
import { ResizableBox } from "react-resizable";
import ScrollRegion from "./ScrollRegion";

import { formatTopic, fetchWikiPage } from "./util.js";
import { titleFromHref } from "./wikiGraph/titles.js";
import clickSound from "/Click_1.wav";

// Links into these namespaces never lead to an article.
const META_LINK_PREFIXES = ["./Wikipedia:", "./Help:", "./File:", "./Special:"];

const DRAG_THRESHOLD = 4;
const ARTICLE_WIDTH = 1000;
const ARTICLE_HEIGHT = 1000;
const ARTICLE_EDGE_GAP = 24;
const FULL_HEIGHT_RATIO = 0.78;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const reflect = (distance, max) => {
  if (max <= 0) {
    return 0;
  }

  const period = max * 2;
  const position = distance % period;
  return position <= max ? position : period - position;
};

const getStageSize = () => {
  const stage = document.getElementById("game-stage");
  return {
    width: stage?.clientWidth ?? window.innerWidth,
    height: stage?.clientHeight ?? window.innerHeight,
  };
};

const getSpawnPosition = (spawnIndex) => {
  const stage = getStageSize();
  const vh = window.innerHeight / 100;
  const start = 5 * vh;
  const steps = Math.max(0, spawnIndex - 1);
  const horizontalDistance = steps * 3 * vh;
  const verticalDistance = steps * 2 * vh;
  const articleWidth = Math.min(
    ARTICLE_WIDTH,
    Math.max(0, stage.width - ARTICLE_EDGE_GAP),
  );
  const maxLeft = Math.max(0, stage.width - articleWidth);
  const maxTop = Math.max(0, stage.height * (1 - FULL_HEIGHT_RATIO));

  return {
    left: reflect(Math.min(start, maxLeft) + horizontalDistance, maxLeft),
    top: reflect(Math.min(start, maxTop) + verticalDistance, maxTop),
  };
};

const containPosition = (article, left, top) => {
  const stage = article?.parentElement;
  if (!article || !stage) {
    return { left, top };
  }

  return {
    left: clamp(left, 0, Math.max(0, stage.clientWidth - article.offsetWidth)),
    top: clamp(top, 0, Math.max(0, stage.clientHeight - article.offsetHeight)),
  };
};

// Auto-opened articles are display-only until selected. Keeping them out of
// ResizableBox avoids one ResizeObserver, drag handlers, and a placeholder
// subtree per background window.
const CondensedArticle = memo(function CondensedArticle({
  topic,
  id,
  spawnIndex,
  stackIndex,
  resurfaceArticle,
  closeArticle,
}) {
  const [position] = useState(() => getSpawnPosition(spawnIndex));
  return (
    <div
      className={`article condensed ${topic}`}
      id={`article-${id}`}
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
        zIndex: stackIndex,
      }}
      onClick={() => resurfaceArticle(id)}
    >
      <button
        className="article-close"
        aria-label={`Close ${formatTopic(topic)}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          closeArticle(id, topic);
        }}
      >
        ×
      </button>
      <div className="article-header condensed-header">{formatTopic(topic)}</div>
      <div className="article-preview-placeholder" aria-hidden="true"></div>
    </div>
  );
});

function FullArticle(props) {
  var {
    topic,
    ordinal,
    id,
    spawnIndex,
    stackIndex,
    isCurrent,
    resurfaceArticle,
    closeArticle,
    processInvalidArticle,
    openLink,
    checkForQuest,
    processSelfLink,
  } = props;

  const [content, setContent] = useState(null);

  const [posTop, setPosTop] = useState(id == 0 ? 0 : null);
  const [posLeft, setPosLeft] = useState(id == 0 ? 0 : null);
  const [stageSize, setStageSize] = useState(getStageSize);
  const [showHighlight, setShowHighlight] = useState(false);
  const dragState = useRef(null);
  const dragFrame = useRef(null);
  const suppressClick = useRef(false);

  var isCondensed = !isCurrent && id != 0;
  const [playSound] = useSound(clickSound);

  useLayoutEffect(() => {
    if (id == 0) {
      return;
    }

    const position = getSpawnPosition(spawnIndex);
    setPosLeft(position.left);
    setPosTop(position.top);
    setStageSize(getStageSize());
  }, [id, spawnIndex]);

  useEffect(() => {
    return () => {
      if (dragFrame.current != null) {
        cancelAnimationFrame(dragFrame.current);
      }
    };
  }, []);

  useEffect(() => {
    if (id == 0) {
      return;
    }

    const article = document.getElementById(`article-${id}`);
    const stage = article?.parentElement;
    if (!article || !stage) {
      return;
    }

    const keepArticleContained = () => {
      setStageSize({
        width: stage.clientWidth,
        height: stage.clientHeight,
      });
      setPosLeft((left) => containPosition(article, left, 0).left);
      setPosTop((top) => containPosition(article, 0, top).top);
    };

    keepArticleContained();
    const resizeObserver = new ResizeObserver(keepArticleContained);
    resizeObserver.observe(stage);
    resizeObserver.observe(article);

    return () => resizeObserver.disconnect();
  }, [id]);

  const checkForQuestRef = useRef(checkForQuest);
  useEffect(() => {
    checkForQuestRef.current = checkForQuest;
  }, [checkForQuest]);

  useEffect(() => {
    if (isCondensed) {
      if (content != null) {
        setContent(null);
      }
      return;
    }

    if (content != null) {
      return;
    }

    // The article's categories arrive with its HTML, so quests are checked
    // when the player actually reads an article. Articles opened by
    // automation are never fetched from Wikipedia.
    async function getContent() {
      const page = await fetchWikiPage(topic);
      setContent(page.html);
      if (checkForQuestRef.current(page.categories, id)) {
        setShowHighlight(true);
      }
    }
    getContent();
  }, [content, id, isCondensed, topic]);

  const ready = isCondensed || content != null;

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
    if (!href) return;

    if (META_LINK_PREFIXES.some((prefix) => href.startsWith(prefix))) {
      console.log("Meta link: " + href);
      processInvalidArticle();
      return;
    }

    // Whether the link leads to an article, and to which one, is decided by
    // the link graph's title index rather than by the link text.
    const linkedTitle = titleFromHref(href);
    if (linkedTitle != null) {
      openLink(linkedTitle, ordinal);
    }
  };

  const updateDragTransform = () => {
    dragFrame.current = null;
    const drag = dragState.current;
    if (!drag || !drag.moved) {
      return;
    }

    const nextPosition = containPosition(
      drag.article,
      drag.startLeft + drag.clientX - drag.startX,
      drag.startTop + drag.clientY - drag.startY,
    );
    const leftDelta = nextPosition.left - drag.startLeft;
    const topDelta = nextPosition.top - drag.startTop;
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
      const nextPosition = containPosition(
        drag.article,
        drag.startLeft + endX - drag.startX,
        drag.startTop + endY - drag.startY,
      );

      // Update the node before committing React state to avoid a one-frame snap.
      drag.article.style.left = `${nextPosition.left}px`;
      drag.article.style.top = `${nextPosition.top}px`;
      drag.article.style.transform = "";
      setPosLeft(nextPosition.left);
      setPosTop(nextPosition.top);

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
    top: (posTop ?? 0) + "px",
    left: (posLeft ?? 0) + "px",
    zIndex: isCondensed ? stackIndex : 1000000,
    visibility: posTop == null ? "hidden" : "visible",
  };

  const availableWidth = Math.max(1, stageSize.width - (posLeft ?? 0));
  const availableHeight = Math.max(1, stageSize.height - (posTop ?? 0));
  const defaultHeight = Math.max(1, stageSize.height * FULL_HEIGHT_RATIO);
  const minConstraints = [
    Math.min(400, availableWidth),
    Math.min(200, availableHeight),
  ];
  const maxConstraints = [availableWidth, availableHeight];

  return (
    <ResizableBox
      className={cn}
      id={"article-" + id}
      style={id == 0 ? {} : articleStyle}
      onClick={onArticleClicked}
      width={ARTICLE_WIDTH}
      height={id == 0 ? ARTICLE_HEIGHT : defaultHeight}
      minConstraints={minConstraints}
      maxConstraints={maxConstraints}
      resizeHandles={id == 0 ? [] : ["se"]}
    >
      {id != 0 && (
        <button
          className="article-close"
          aria-label={`Close ${formatTopic(topic)}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            closeArticle(id, topic);
          }}
        >
          ×
        </button>
      )}
      <div
        className={"article-header " + (isCondensed ? "condensed-header" : "")}
        id={"article-header-" + id}
        onPointerDown={startDrag}
        onPointerMove={articleDragged}
        onPointerUp={closeDragElement}
        onPointerCancel={closeDragElement}
      >
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
        <ScrollRegion className="article-scroll-region">
          <div
            className="article-content"
            id={"article-content-" + id}
            dangerouslySetInnerHTML={{ __html: content }}
            style={{ lineHeight: 1.66 }}
          />
        </ScrollRegion>
      )}
      {ready && isCondensed && (
        <div className="article-preview-placeholder" aria-hidden="true">
          <div className="article-preview-top">
            <div className="article-preview-lines">
              {Array.from({ length: 6 }, (_, index) => (
                <div className="article-preview-line" key={index}></div>
              ))}
            </div>
            <div className="article-preview-image"></div>
          </div>
          <div className="article-preview-lines">
            {Array.from({ length: 14 }, (_, index) => (
              <div className="article-preview-line" key={index}></div>
            ))}
          </div>
        </div>
      )}
    </ResizableBox>
  );
}

const MemoFullArticle = memo(FullArticle);

// Switching between these two component types intentionally unmounts the
// heavy article body when it returns to the background.
function Article(props) {
  if (!props.isCurrent && props.id != 0) {
    return <CondensedArticle {...props} />;
  }
  return <MemoFullArticle {...props} />;
}

export default memo(Article);
