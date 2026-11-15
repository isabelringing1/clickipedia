#!/usr/bin/env python3
"""Normalize a CirrusSearch content dump into Clickipedia topic-score JSONL."""

import argparse
import bz2
import concurrent.futures
import gzip
import hashlib
import heapq
import json
import os
from pathlib import Path
import tempfile
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


FAMILIES = (
    "classification.prediction.articletopic/",
    "classification.ores.articletopic/",
)


class HashingWriter:
    def __init__(self, path: Path):
        self.file = path.open("wb")
        self.sha1 = hashlib.sha1()
        self.bytes = 0

    def write(self, data: bytes):
        self.file.write(data)
        self.sha1.update(data)
        self.bytes += len(data)

    def close(self):
        self.file.close()


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path, nargs="+", help="CirrusSearch JSON partitions")
    parser.add_argument("--output", type=Path, required=True, help="normalized JSONL destination")
    parser.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    parser.add_argument(
        "--catalog",
        type=Path,
        default=Path(__file__).resolve().parents[3] / "topic-catalog.json",
    )
    return parser.parse_args()


def topic_lookup(catalog):
    lookup = {}
    for topic in catalog["topics"]:
        source_label = topic["label"].replace(" ", "_")
        if source_label in lookup:
            raise ValueError(f"duplicate source label {source_label!r}")
        lookup[source_label] = topic["id"]
    if len(lookup) != 64:
        raise ValueError("topic catalog must contain exactly 64 topics")
    return lookup


def topic_scores(document, lookup):
    scores = {}
    for tag in document.get("weighted_tags", ()):
        family = next((prefix for prefix in FAMILIES if tag.startswith(prefix)), None)
        if family is None:
            continue
        prediction = tag[len(family) :]
        name, separator, raw_score = prediction.rpartition("|")
        if not separator:
            continue
        source_label = name.rsplit(".", 1)[-1]
        topic_id = lookup.get(source_label)
        if topic_id is None:
            raise ValueError(f"unknown article-topic label {source_label!r}")
        try:
            parsed = Decimal(raw_score)
        except InvalidOperation as error:
            raise ValueError(f"invalid article-topic score {raw_score!r}") from error
        if "." in raw_score:
            if not Decimal(0) <= parsed <= Decimal(1):
                raise ValueError(f"article-topic probability outside 0..1: {raw_score}")
            score = int((parsed * 1_000_000).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        else:
            score_thousandths = int(parsed)
            if not 0 <= score_thousandths <= 1000:
                raise ValueError(
                    f"article-topic score outside 0..1000: {score_thousandths}"
                )
            score = score_thousandths * 1000
        scores[topic_id] = score
    return scores


def open_compressed(path: Path):
    if path.suffix == ".bz2":
        return bz2.open(path, "rt", encoding="utf-8")
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    raise ValueError(f"unsupported compressed input {path}")


def normalize_partition(arguments):
    source, destination, catalog_path = arguments
    catalog_bytes = catalog_path.read_bytes()
    catalog = json.loads(catalog_bytes)
    lookup = topic_lookup(catalog)
    topic_order = {topic["id"]: index for index, topic in enumerate(catalog["topics"])}
    rows = []

    classified = 0
    with open_compressed(source) as stream:
        while True:
            action_line = stream.readline()
            if not action_line:
                break
            document_line = stream.readline()
            if not document_line:
                raise ValueError(f"{source} ends after an action row")
            action = json.loads(action_line)
            document = json.loads(document_line)
            page_id = int(document["page_id"])
            action_id = int(action["index"]["_id"])
            if action_id != page_id:
                raise ValueError(
                    f"{source}: action ID {action_id} does not match page ID {page_id}"
                )
            if int(document.get("namespace", -1)) != 0:
                continue
            scores = topic_scores(document, lookup)
            ordered = sorted(scores.items(), key=lambda item: topic_order[item[0]])
            encoded = (
                json.dumps(
                    {"pageId": page_id, "scores": ordered},
                    separators=(",", ":"),
                    ensure_ascii=False,
                ).encode("utf-8")
                + b"\n"
            )
            rows.append((page_id, encoded))
            classified += bool(ordered)

    rows.sort(key=lambda row: row[0])
    for previous, current in zip(rows, rows[1:]):
        if previous[0] == current[0]:
            raise ValueError(f"{source}: duplicate page ID {current[0]}")
    with destination.open("wb") as output:
        for _, encoded in rows:
            output.write(encoded)
    return source.name, len(rows), classified


def read_partition(path):
    with path.open("rb") as stream:
        for line in stream:
            row = json.loads(line)
            yield row["pageId"], line


def normalize(sources, destination: Path, catalog_path: Path, workers: int):
    catalog_bytes = catalog_path.read_bytes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    writer = HashingWriter(temporary)

    with tempfile.TemporaryDirectory(
        prefix="clickipedia-topics-", dir=destination.parent
    ) as temporary_directory:
        directory = Path(temporary_directory)
        part_paths = [directory / f"{index:05}.jsonl" for index in range(len(sources))]
        jobs = [
            (source, part_paths[index], catalog_path)
            for index, source in enumerate(sources)
        ]
        rows = 0
        classified = 0
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as pool:
            for name, part_rows, part_classified in pool.map(normalize_partition, jobs):
                rows += part_rows
                classified += part_classified
                print(
                    f"normalized {name}: {part_rows:,} articles "
                    f"({rows:,} total)",
                    flush=True,
                )

        previous_page_id = -1
        try:
            for page_id, line in heapq.merge(
                *(read_partition(path) for path in part_paths),
                key=lambda row: row[0],
            ):
                if page_id <= previous_page_id:
                    raise ValueError(
                        f"page IDs are not unique across partitions: {page_id}"
                    )
                previous_page_id = page_id
                writer.write(line)
        finally:
            writer.close()

    temporary.replace(destination)
    print(
        json.dumps(
            {
                "file": destination.name,
                "bytes": writer.bytes,
                "sha1": writer.sha1.hexdigest(),
                "catalogSha256": hashlib.sha256(catalog_bytes).hexdigest(),
                "rows": rows,
                "classifiedRows": classified,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    arguments = parse_args()
    normalize(arguments.input, arguments.output, arguments.catalog, arguments.workers)
