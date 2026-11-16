import {
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { useSound } from "use-sound";
import { SpinnerCircularFixed } from "spinners-react";
import ScrollRegion from "./ScrollRegion";

import { formatTopic, fetchWikiPage, fetchWikiPreview } from "./util.js";
import { titleFromHref } from "./wikiGraph/titles.js";
import clickSound from "/Click_1.wav";

// Links into these namespaces never lead to an article.
const META_LINK_PREFIXES = ["./Wikipedia:", "./Help:", "./File:", "./Special:"];

const DRAG_THRESHOLD = 4;
const ARTICLE_WIDTH = 800;
const MIN_ARTICLE_WIDTH = 400;
const MIN_ARTICLE_HEIGHT = 200;
// Matches the max-width and max-height of .article in App.css.
const ARTICLE_EDGE_GAP = 24;
const RESIZE_HANDLES = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const FULL_HEIGHT_RATIO = 0.78;
const LINK_PREVIEW_DELAY_MS = 300;
const LINK_PREVIEW_WIDTH = 430;
const LINK_PREVIEW_ESTIMATED_HEIGHT = 290;

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

function ArticleLinkPreview({ preview }) {
  if (!preview) return null;
  return createPortal(
    <aside
      className={`article-link-preview${preview.thumbnail ? " has-image" : ""}`}
      role="tooltip"
      style={{ left: `${preview.left}px`, top: `${preview.top}px` }}
    >
      <div className="article-link-preview-copy">
        <strong>{preview.title}</strong>
        {preview.extract && <p>{preview.extract}</p>}
      </div>
      {preview.thumbnail && (
        <img src={preview.thumbnail} alt="" aria-hidden="true" />
      )}
    </aside>,
    document.body,
  );
}

function WikipediaLink({ topic }) {
  const articlePath = encodeURIComponent(topic.replaceAll(" ", "_"));
  return (
    <a
      className="article-external-link"
      href={`https://en.wikipedia.org/wiki/${articlePath}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${formatTopic(topic)} on Wikipedia`}
      title="Open on Wikipedia"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 4h6v6m0-6L10 14m8-1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" />
      </svg>
    </a>
  );
}

function tableOfContentsFrom(html) {
  if (!html) return [];
  const document = new DOMParser().parseFromString(html, "text/html");
  const roots = [];
  const stack = [];

  for (const heading of document.querySelectorAll("h2[id], h3[id], h4[id], h5[id], h6[id]")) {
    const level = Number(heading.tagName.slice(1));
    const label = heading.textContent.trim();
    if (!label) continue;
    const item = { id: heading.id, label, level, children: [] };
    while (stack.length > 0 && stack.at(-1).level >= level) {
      stack.pop();
    }
    if (stack.length > 0) {
      stack.at(-1).children.push(item);
    } else {
      roots.push(item);
    }
    stack.push(item);
  }
  return roots;
}

function ContentsItems({ items, expanded, toggle, navigate }) {
  return (
    <ul className="article-contents-list">
      {items.map((item) => {
        const hasChildren = item.children.length > 0;
        const isExpanded = expanded.has(item.id);
        return (
          <li key={item.id}>
            <div className="article-contents-row">
              {hasChildren ? (
                <button
                  className="article-contents-expand"
                  type="button"
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${item.label}`}
                  aria-expanded={isExpanded}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(item.id);
                  }}
                >
                  ›
                </button>
              ) : (
                <span className="article-contents-expand-spacer"></span>
              )}
              <button
                className="article-contents-section"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  navigate(item.id);
                }}
              >
                {item.label}
              </button>
            </div>
            {hasChildren && isExpanded && (
              <ContentsItems
                items={item.children}
                expanded={expanded}
                toggle={toggle}
                navigate={navigate}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

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

// Where the article ends up after the pointer has moved (dx, dy) since the
// resize began. Only the edges the handle owns move, each within the stage,
// so the opposite edges stay where they were.
const resizeRect = (start, handle, dx, dy, stage) => {
  let { left, top } = start;
  let right = start.left + start.width;
  let bottom = start.top + start.height;
  const minWidth = Math.min(MIN_ARTICLE_WIDTH, start.width);
  const minHeight = Math.min(MIN_ARTICLE_HEIGHT, start.height);
  const maxWidth = stage.clientWidth - ARTICLE_EDGE_GAP;
  const maxHeight = stage.clientHeight - ARTICLE_EDGE_GAP;

  if (handle.includes("w")) {
    left = clamp(left + dx, Math.max(0, right - maxWidth), right - minWidth);
  } else if (handle.includes("e")) {
    right = clamp(
      right + dx,
      left + minWidth,
      Math.min(stage.clientWidth, left + maxWidth),
    );
  }
  if (handle.includes("n")) {
    top = clamp(top + dy, Math.max(0, bottom - maxHeight), bottom - minHeight);
  } else if (handle.includes("s")) {
    bottom = clamp(
      bottom + dy,
      top + minHeight,
      Math.min(stage.clientHeight, top + maxHeight),
    );
  }

  return { left, top, width: right - left, height: bottom - top };
};

// Auto-opened articles are display-only until selected. Keeping them free of
// resize handles, a ResizeObserver, and a placeholder subtree keeps each
// background window cheap.
const CondensedArticle = memo(function CondensedArticle({
  topic,
  id,
  stackIndex,
  position,
  setPosition,
  resurfaceArticle,
  closeArticle,
}) {
  const dragState = useRef(null);
  const dragFrame = useRef(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    return () => {
      if (dragFrame.current != null) {
        cancelAnimationFrame(dragFrame.current);
      }
    };
  }, []);

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
    drag.article.style.transform = `translate3d(${
      nextPosition.left - drag.startLeft
    }px, ${nextPosition.top - drag.startTop}px, 0)`;
  };

  const startDrag = (event) => {
    if (event.button != 0) {
      return;
    }

    const article = event.currentTarget.closest(".article");
    if (!article) {
      return;
    }

    suppressClick.current = false;
    dragState.current = {
      article,
      header: event.currentTarget,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      startLeft: position.left,
      startTop: position.top,
      moved: false,
    };
    article.classList.add("dragging");
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const dragArticle = (event) => {
    const drag = dragState.current;
    if (!drag || event.pointerId != drag.pointerId) {
      return;
    }

    event.preventDefault();
    drag.clientX = event.clientX;
    drag.clientY = event.clientY;
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >=
        DRAG_THRESHOLD
    ) {
      drag.moved = true;
      suppressClick.current = true;
    }
    if (drag.moved && dragFrame.current == null) {
      dragFrame.current = requestAnimationFrame(updateDragTransform);
    }
  };

  const endDrag = (event) => {
    const drag = dragState.current;
    if (!drag || event.pointerId != drag.pointerId) {
      return;
    }

    if (dragFrame.current != null) {
      cancelAnimationFrame(dragFrame.current);
      dragFrame.current = null;
    }

    const endX = event.type === "pointercancel" ? drag.clientX : event.clientX;
    const endY = event.type === "pointercancel" ? drag.clientY : event.clientY;
    const moved =
      drag.moved ||
      Math.hypot(endX - drag.startX, endY - drag.startY) >= DRAG_THRESHOLD;

    if (moved) {
      const nextPosition = containPosition(
        drag.article,
        drag.startLeft + endX - drag.startX,
        drag.startTop + endY - drag.startY,
      );
      drag.article.style.left = `${nextPosition.left}px`;
      drag.article.style.top = `${nextPosition.top}px`;
      drag.article.style.transform = "";
      setPosition(nextPosition);

      if (event.type === "pointercancel") {
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

  return (
    <div
      className={`article condensed ${topic}`}
      id={`article-${id}`}
      style={{
        top: `${position?.top ?? 0}px`,
        left: `${position?.left ?? 0}px`,
        zIndex: stackIndex,
        visibility: position == null ? "hidden" : "visible",
      }}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        resurfaceArticle(id);
      }}
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
      <div
        className="article-header condensed-header"
        onPointerDown={startDrag}
        onPointerMove={dragArticle}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {formatTopic(topic)}
        <WikipediaLink topic={topic} />
      </div>
      <div className="article-preview-placeholder" aria-hidden="true"></div>
    </div>
  );
});

function FullArticle(props) {
  var {
    topic,
    ordinal,
    id,
    stackIndex,
    isCurrent,
    position,
    setPosition,
    scrollPositionRef,
    resurfaceArticle,
    closeArticle,
    processInvalidArticle,
    openLink,
    checkForQuest,
    processSelfLink,
  } = props;

  const [content, setContent] = useState(null);
  const [linkPreview, setLinkPreview] = useState(null);
  const [showContents, setShowContents] = useState(false);
  const [expandedContents, setExpandedContents] = useState(() => new Set());

  const [stageSize, setStageSize] = useState(getStageSize);
  // Null until the player resizes the article; it has its default size then.
  const [size, setSize] = useState(null);
  const [showHighlight, setShowHighlight] = useState(false);
  const dragState = useRef(null);
  const resizeState = useRef(null);
  const dragFrame = useRef(null);
  const suppressClick = useRef(false);
  const linkPreviewTimer = useRef(null);
  const linkPreviewRequest = useRef(0);
  const linkPreviewAnchor = useRef(null);
  const contentsControlRef = useRef(null);

  // React assigns innerHTML again whenever this prop is a different object,
  // even when the HTML is the same. That replaces every node in the article,
  // so the object has to keep its identity until the content changes.
  const contentHtml = useMemo(() => ({ __html: content }), [content]);
  const contents = useMemo(() => tableOfContentsFrom(content), [content]);

  var isCondensed = !isCurrent && id != 0;
  const [playSound] = useSound(clickSound);

  const posTop = position?.top ?? null;
  const posLeft = position?.left ?? null;

  useLayoutEffect(() => {
    setStageSize(getStageSize());
  }, []);

  useEffect(() => {
    if (!showContents) return;
    const closeContents = (event) => {
      if (!contentsControlRef.current?.contains(event.target)) {
        setShowContents(false);
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setShowContents(false);
    };
    document.addEventListener("pointerdown", closeContents);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeContents);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showContents]);

  const navigateContents = (targetId) => {
    const articleContent = document.getElementById(`article-content-${id}`);
    const scroller = articleContent?.closest(".scroll-region-content");
    if (!articleContent || !scroller) return;
    if (targetId === null) {
      scroller.scrollTop = 0;
    } else {
      const target = [...articleContent.querySelectorAll("[id]")].find(
        (element) => element.id === targetId,
      );
      if (target) {
        scroller.scrollTop +=
          target.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top;
      }
    }
    setShowContents(false);
  };

  const toggleContents = (targetId) => {
    setExpandedContents((current) => {
      const next = new Set(current);
      if (next.has(targetId)) next.delete(targetId);
      else next.add(targetId);
      return next;
    });
  };

  useEffect(() => {
    return () => {
      if (dragFrame.current != null) {
        cancelAnimationFrame(dragFrame.current);
      }
      if (linkPreviewTimer.current != null) {
        clearTimeout(linkPreviewTimer.current);
      }
      linkPreviewRequest.current += 1;
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
      if (resizeState.current) {
        return;
      }
      setPosition((current) => {
        if (!current) {
          return current;
        }
        const next = containPosition(article, current.left, current.top);
        return next.left == current.left && next.top == current.top
          ? current
          : next;
      });
    };

    keepArticleContained();
    const resizeObserver = new ResizeObserver(keepArticleContained);
    resizeObserver.observe(stage);
    resizeObserver.observe(article);

    return () => resizeObserver.disconnect();
  }, [id, setPosition]);

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
      if (checkForQuestRef.current(page.categories, id, topic)) {
        setShowHighlight(true);
      }
    }
    getContent();
  }, [content, id, isCondensed, topic]);

  const ready = isCondensed || content != null;

  const hideLinkPreview = () => {
    if (linkPreviewTimer.current != null) {
      clearTimeout(linkPreviewTimer.current);
      linkPreviewTimer.current = null;
    }
    linkPreviewRequest.current += 1;
    linkPreviewAnchor.current = null;
    setLinkPreview(null);
  };

  const showLinkPreview = (event) => {
    const link = event.target.closest("a");
    // Moving between elements inside the same link is not a new hover.
    if (!link || link === linkPreviewAnchor.current) return;
    const href = link.getAttribute("href");
    if (
      !href ||
      META_LINK_PREFIXES.some((prefix) => href.startsWith(prefix))
    ) {
      return;
    }
    const linkedTitle = titleFromHref(href);
    if (linkedTitle == null) return;

    hideLinkPreview();
    linkPreviewAnchor.current = link;
    const requestId = linkPreviewRequest.current;
    linkPreviewTimer.current = setTimeout(async () => {
      linkPreviewTimer.current = null;
      const page = await fetchWikiPreview(linkedTitle);
      if (
        requestId !== linkPreviewRequest.current ||
        page == null ||
        !link.isConnected
      ) {
        return;
      }

      // Measured now rather than at hover time, in case the article scrolled
      // while the preview was loading.
      const rect = link.getBoundingClientRect();
      const left = clamp(
        rect.left,
        8,
        Math.max(8, window.innerWidth - LINK_PREVIEW_WIDTH - 8),
      );
      const below = rect.bottom + 8;
      const top =
        below + LINK_PREVIEW_ESTIMATED_HEIGHT <= window.innerHeight
          ? below
          : Math.max(8, rect.top - LINK_PREVIEW_ESTIMATED_HEIGHT - 8);
      setLinkPreview({ ...page, left, top });
    }, LINK_PREVIEW_DELAY_MS);
  };

  const leaveLinkPreview = (event) => {
    const anchor = linkPreviewAnchor.current;
    if (
      !anchor ||
      !anchor.contains(event.target) ||
      anchor.contains(event.relatedTarget)
    ) {
      return;
    }
    hideLinkPreview();
  };

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
      setPosition(nextPosition);

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

  const startResize = (event, handle) => {
    if (event.button != 0 || position == null) {
      return;
    }

    const article = event.currentTarget.closest(".article");
    const stage = article?.parentElement;
    if (!stage) {
      return;
    }

    event.preventDefault();
    const rect = article.getBoundingClientRect();
    resizeState.current = {
      handle,
      stage,
      handleNode: event.currentTarget,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: position.left,
      top: position.top,
      width: rect.width,
      height: rect.height,
    };
    suppressClick.current = true;
    // Capturing keeps the moves coming wherever the pointer goes, including
    // outside the stage and outside the browser window.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const resizeArticle = (event) => {
    const resize = resizeState.current;
    if (!resize || event.pointerId != resize.pointerId) {
      return;
    }

    // Measured from where the resize began rather than from the previous
    // move, so the edge is back under the pointer as soon as it returns from
    // beyond a limit.
    const next = resizeRect(
      resize,
      resize.handle,
      event.clientX - resize.startX,
      event.clientY - resize.startY,
      resize.stage,
    );
    setSize((current) =>
      current?.width == next.width && current?.height == next.height
        ? current
        : { width: next.width, height: next.height },
    );
    setPosition((current) =>
      current?.left == next.left && current?.top == next.top
        ? current
        : { left: next.left, top: next.top },
    );
  };

  const finishResize = (event) => {
    const resize = resizeState.current;
    if (!resize || event.pointerId != resize.pointerId) {
      return;
    }

    if (event.type !== "pointercancel") {
      resizeArticle(event);
    }
    if (resize.handleNode.hasPointerCapture(resize.pointerId)) {
      resize.handleNode.releasePointerCapture(resize.pointerId);
    }
    resizeState.current = null;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
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
  if (showContents) {
    cn += " contents-open";
  }
  cn += isCondensed ? " condensed" : " full";

  const defaultHeight = Math.max(1, stageSize.height * FULL_HEIGHT_RATIO);

  var articleStyle = {
    top: (posTop ?? 0) + "px",
    left: (posLeft ?? 0) + "px",
    width: (size?.width ?? ARTICLE_WIDTH) + "px",
    height: (size?.height ?? defaultHeight) + "px",
    zIndex: isCondensed ? stackIndex : 1000000,
    visibility: posTop == null ? "hidden" : "visible",
  };

  return (
    <div
      className={cn}
      id={"article-" + id}
      style={id == 0 ? {} : articleStyle}
      onClick={onArticleClicked}
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
        {contents.length > 0 && (
          <span
            className="article-contents-control"
            ref={contentsControlRef}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              className="article-contents-toggle"
              type="button"
              aria-label={`Table of contents for ${formatTopic(topic)}`}
              aria-expanded={showContents}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setShowContents((current) => !current);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
              </svg>
            </button>
            {showContents && (
              <div
                className="article-contents-menu"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="article-contents-heading">Contents</div>
                <button
                  className="article-contents-top"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    navigateContents(null);
                  }}
                >
                  (Top)
                </button>
                <ContentsItems
                  items={contents}
                  expanded={expandedContents}
                  toggle={toggleContents}
                  navigate={navigateContents}
                />
              </div>
            )}
          </span>
        )}
        {formatTopic(topic)}
        <WikipediaLink topic={topic} />
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
        <ScrollRegion
          className="article-scroll-region"
          scrollPositionRef={scrollPositionRef}
        >
          <div
            className="article-content mw-parser-output"
            id={"article-content-" + id}
            onMouseOver={showLinkPreview}
            onMouseOut={leaveLinkPreview}
            dangerouslySetInnerHTML={contentHtml}
            style={{ lineHeight: 1.66 }}
          />
        </ScrollRegion>
      )}
      <ArticleLinkPreview preview={linkPreview} />
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
      {id != 0 &&
        RESIZE_HANDLES.map((handle) => (
          <span
            key={handle}
            className={`react-resizable-handle react-resizable-handle-${handle}`}
            onPointerDown={(event) => startResize(event, handle)}
            onPointerMove={resizeArticle}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
          />
        ))}
    </div>
  );
}

const MemoFullArticle = memo(FullArticle);

// Switching between these two component types intentionally unmounts the
// heavy article body when it returns to the background.
function Article(props) {
  const { id, spawnIndex } = props;
  const [position, setPosition] = useState(() =>
    id == 0 ? { left: 0, top: 0 } : null,
  );

  useLayoutEffect(() => {
    if (id != 0 && position == null) {
      setPosition(getSpawnPosition(spawnIndex));
    }
  }, [id, position, spawnIndex]);

  const positionedProps = { ...props, position, setPosition };
  if (!props.isCurrent && props.id != 0) {
    return <CondensedArticle {...positionedProps} />;
  }
  return <MemoFullArticle {...positionedProps} />;
}

export default memo(Article);
