/* eslint-disable react-refresh/only-export-components */
import { useState } from "react";
import { createPortal } from "react-dom";
import topicCatalog from "../topic-catalog.json";
import { articlesPerSecond } from "./game/automation.js";

export const TOPICS = [
  {
    label: "Culture",
    children: [
      { label: "Biography", children: ["Biography*", "Women"] },
      "Food and drink",
      "Internet culture",
      "Linguistics",
      "Literature",
      {
        label: "Media",
        children: [
          "Media*",
          "Books",
          "Entertainment",
          "Films",
          "Music",
          "Radio",
          "Software",
          "Television",
          "Video games",
        ],
      },
      "Performing arts",
      "Philosophy and religion",
      "Sports",
      {
        label: "Visual arts",
        children: ["Visual arts*", "Architecture", "Comics and Anime", "Fashion"],
      },
    ],
  },
  {
    label: "Geography",
    children: [
      "Geographical",
      {
        label: "Regions",
        children: [
          {
            label: "Africa",
            children: [
              "Africa*",
              "Central Africa",
              "Eastern Africa",
              "Northern Africa",
              "Southern Africa",
              "Western Africa",
            ],
          },
          {
            label: "Americas",
            children: ["Central America", "North America", "South America"],
          },
          {
            label: "Asia",
            children: [
              "Asia*",
              "Central Asia",
              "East Asia",
              "North Asia",
              "South Asia",
              "Southeast Asia",
              "West Asia",
            ],
          },
          {
            label: "Europe",
            children: [
              "Europe*",
              "Eastern Europe",
              "Northern Europe",
              "Southern Europe",
              "Western Europe",
            ],
          },
          "Oceania",
        ],
      },
    ],
  },
  {
    label: "History and Society",
    children: [
      "Business and economics",
      "Education",
      "History",
      "Military and warfare",
      "Politics and government",
      "Society",
      "Transportation",
    ],
  },
  {
    label: "STEM",
    children: [
      "STEM*",
      "Biology",
      "Chemistry",
      "Computing",
      "Earth and environment",
      "Engineering",
      "Libraries & Information",
      "Mathematics",
      "Medicine & Health",
      "Physics",
      "Space",
      "Technology",
    ],
  },
];

export const TOPIC_ROOMS = topicCatalog.topics.map((topic, topicIndex) => ({
  ...topic,
  topicIndex,
}));

function topicStats(room, total) {
  const opened = Math.min(
    Math.max(0, (room?.visitedCount ?? room?.topicOpenedCount ?? 1) - 1),
    total || Infinity,
  );
  return {
    opened,
    percent: total > 0 ? (100 * opened) / total : 0,
    autos: room?.autos ?? 0,
  };
}

export function TopicProgress({ room, total, showTooltip = false }) {
  if (!room) return null;
  const { opened, percent: progress } = topicStats(room, total);
  const progressText = `${opened.toLocaleString()} / ${total.toLocaleString()}`;
  const tooltipText = `${progressText} (${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(progress)}%)`;
  return (
    <div
      className={`topic-room-progress${showTooltip ? " hover-tooltip" : ""}`}
      aria-label={`${progressText} articles opened`}
      data-tooltip={showTooltip ? tooltipText : undefined}
      tabIndex={showTooltip ? 0 : undefined}
    >
      <div className="topic-progress-track" aria-hidden="true">
        <div style={{ width: `${Math.min(100, progress)}%` }} />
      </div>
    </div>
  );
}

function TopicTooltip({ tooltip }) {
  if (!tooltip) return null;
  const { room, total, x, y } = tooltip;
  const { opened, percent, autos } = topicStats(room, total);
  const rate = articlesPerSecond(autos);
  const numberFormat = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  });
  return createPortal(
    <div
      className={`topic-tooltip${room ? "" : " locked"}`}
      role="tooltip"
      style={{ left: `${x}px`, top: `${y}px` }}
    >
      {room ? (
        <>
          <div className="topic-tooltip-row">
            <span>Articles</span>
            <strong>
              {opened.toLocaleString()} / {total.toLocaleString()} (
              {numberFormat.format(percent)}%)
            </strong>
          </div>
          <div className="topic-tooltip-row">
            <span>Autos</span>
            <strong>{autos.toLocaleString()}</strong>
          </div>
          <div className="topic-tooltip-row">
            <span>Rate</span>
            <strong>{numberFormat.format(rate)} pages/s</strong>
          </div>
        </>
      ) : (
        <strong>Locked</strong>
      )}
    </div>,
    document.body,
  );
}

function TopicBranch({
  topic,
  depth = 0,
  onSelectTopic,
  onHoverTopic,
  onLeaveTopic,
  roomByLabel,
  topicCounts,
}) {
  const branch = typeof topic === "string" ? { label: topic } : topic;
  const [expanded, setExpanded] = useState(true);
  const hasChildren = branch.children?.length > 0;
  const definition = !hasChildren
    ? TOPIC_ROOMS.find((room) => room.label === branch.label)
    : null;
  const room = definition ? roomByLabel[branch.label] : null;

  return (
    <li className="topic-item">
      <div
        className="topic-row"
        style={{ "--topic-depth": depth }}
        onMouseEnter={
          hasChildren
            ? undefined
            : (event) =>
                onHoverTopic(
                  event,
                  room,
                  topicCounts?.[definition.id] ?? 0,
                )
        }
        onMouseLeave={hasChildren ? undefined : onLeaveTopic}
      >
        {hasChildren ? (
          <button
            className="topic-collapse"
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} ${branch.label}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="topic-leaf-marker" aria-hidden="true">
            •
          </span>
        )}
        {hasChildren ? (
          <span className="topic-container-label">{branch.label}</span>
        ) : (
          <>
            <button
              className={`topic-link${room ? "" : " locked"}`}
              type="button"
              disabled={!room}
              onClick={(event) =>
                onSelectTopic(definition.id, event.currentTarget)
              }
            >
              {branch.label}
              {room?.newlyUnlocked && (
                <span className="topic-new"> New!</span>
              )}
              {room?.blocked && <span className="room-warning"> !</span>}
              {!room && (
                <span className="topic-lock-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" focusable="false">
                    <path
                      d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3 7.5h10v7H3z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                  </svg>
                </span>
              )}
            </button>
            <TopicProgress
              room={room}
              total={topicCounts?.[definition.id] ?? 0}
            />
          </>
        )}
      </div>
      {hasChildren && expanded && (
        <ul className="topic-list">
          {branch.children.map((child) => {
            const label = typeof child === "string" ? child : child.label;
            return (
              <TopicBranch
                key={label}
                topic={child}
                depth={depth + 1}
                onSelectTopic={onSelectTopic}
                onHoverTopic={onHoverTopic}
                onLeaveTopic={onLeaveTopic}
                roomByLabel={roomByLabel}
                topicCounts={topicCounts}
              />
            );
          })}
        </ul>
      )}
    </li>
  );
}

function TopicColumn({
  topic,
  onSelectTopic,
  onHoverTopic,
  onLeaveTopic,
  roomByLabel,
  topicCounts,
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <section className="topic-column">
      <div className="topic-heading">
        <button
          className="topic-collapse topic-heading-collapse"
          type="button"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${topic.label}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <h2 className="topic-container-label">{topic.label}</h2>
      </div>
      {expanded && (
        <ul className="topic-list topic-root-list">
          {topic.children.map((child) => {
            const label = typeof child === "string" ? child : child.label;
            return (
              <TopicBranch
                key={label}
                topic={child}
                onSelectTopic={onSelectTopic}
                onHoverTopic={onHoverTopic}
                onLeaveTopic={onLeaveTopic}
                roomByLabel={roomByLabel}
                topicCounts={topicCounts}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TopicTaxonomy({
  onSelectTopic,
  rooms,
  topicCounts,
  globalVisitedCount,
  articleCount,
}) {
  const [expanded, setExpanded] = useState(true);
  const [tooltip, setTooltip] = useState(null);
  const roomByLabel = Object.fromEntries(
    Object.values(rooms).map((room) => [room.label, room]),
  );
  const showTooltip = (event, room, total) => {
    const link =
      event.currentTarget.querySelector(".topic-link") ?? event.currentTarget;
    const rect = link.getBoundingClientRect();
    const x = rect.left;
    const y = rect.bottom;
    setTooltip({ room, total, x, y });
  };
  return (
    <>
      <aside className="topic-taxonomy" aria-label="Article topic controls">
        <div
          className="general-topic-heading"
          onMouseEnter={(event) =>
            showTooltip(
              event,
              { ...rooms.general, visitedCount: globalVisitedCount },
              articleCount,
            )
          }
          onMouseLeave={() => setTooltip(null)}
        >
          <button
            className="topic-collapse topic-heading-collapse"
            type="button"
            aria-label={`${expanded ? "Collapse" : "Expand"} General`}
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "▾" : "▸"}
          </button>
          <div className="general-topic-content">
            <h2>
              <button
                className="topic-link topic-heading-link"
                type="button"
                onClick={(event) =>
                  onSelectTopic("general", event.currentTarget)
                }
              >
                General
                {rooms.general?.blocked && (
                  <span className="room-warning"> !</span>
                )}
              </button>
            </h2>
            <TopicProgress
              room={{ visitedCount: globalVisitedCount }}
              total={articleCount}
            />
          </div>
        </div>
        {expanded && (
          <div className="topic-columns">
            {TOPICS.map((topic) => (
              <TopicColumn
                key={topic.label}
                topic={topic}
                onSelectTopic={onSelectTopic}
                onHoverTopic={showTooltip}
                onLeaveTopic={() => setTooltip(null)}
                roomByLabel={roomByLabel}
                topicCounts={topicCounts}
              />
            ))}
          </div>
        )}
      </aside>
      <TopicTooltip tooltip={tooltip} />
    </>
  );
}

export default TopicTaxonomy;
