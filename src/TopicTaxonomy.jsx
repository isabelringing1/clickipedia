import { useState } from "react";

const TOPICS = [
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

function TopicBranch({ topic, depth = 0 }) {
  const branch = typeof topic === "string" ? { label: topic } : topic;
  const [expanded, setExpanded] = useState(true);
  const hasChildren = branch.children?.length > 0;

  return (
    <li className="topic-item">
      <div className="topic-row" style={{ "--topic-depth": depth }}>
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
        <span>{branch.label}</span>
      </div>
      {hasChildren && expanded && (
        <ul className="topic-list">
          {branch.children.map((child) => {
            const label = typeof child === "string" ? child : child.label;
            return <TopicBranch key={label} topic={child} depth={depth + 1} />;
          })}
        </ul>
      )}
    </li>
  );
}

function TopicColumn({ topic }) {
  const [expanded, setExpanded] = useState(true);
  const [value, setValue] = useState(0);

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
        <h2>{topic.label}</h2>
        <div className="topic-counter">
          <output aria-label={`${topic.label} value`}>{value}</output>
          <span className="topic-counter-buttons">
            <button
              type="button"
              aria-label={`Increase ${topic.label}`}
              onClick={() => setValue((current) => current + 1)}
            >
              ▴
            </button>
            <button
              type="button"
              aria-label={`Decrease ${topic.label}`}
              onClick={() => setValue((current) => Math.max(0, current - 1))}
            >
              ▾
            </button>
          </span>
        </div>
      </div>
      {expanded && (
        <ul className="topic-list topic-root-list">
          {topic.children.map((child) => {
            const label = typeof child === "string" ? child : child.label;
            return <TopicBranch key={label} topic={child} />;
          })}
        </ul>
      )}
    </section>
  );
}

function TopicTaxonomy() {
  return (
    <aside className="topic-taxonomy" aria-label="Article topic controls">
      {TOPICS.map((topic) => (
        <TopicColumn key={topic.label} topic={topic} />
      ))}
    </aside>
  );
}

export default TopicTaxonomy;
