import hashlib
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

PEOPLE = {"jiang": "蔣萬安", "shen": "沈伯洋"}
MAX_BYTES = 4_000_000
RETENTION_DAYS = 365
QUERY_DAYS = 7


def stamp(value):
    return value.astimezone(timezone.utc).isoformat()


def parse_time(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("時間必須包含時區")
    return result.astimezone(timezone.utc)


def safe_url(value):
    try:
        parsed = urllib.parse.urlsplit(value or "")
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return ""
        if parsed.username or parsed.password:
            return ""
        return urllib.parse.urlunsplit(parsed)
    except (TypeError, ValueError):
        return ""


def clean(value):
    text = html.unescape(value or "")
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", "", text)).strip()


def canonical(value):
    parsed = urllib.parse.urlsplit(safe_url(value))
    query = [
        (key, val)
        for key, val in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        if not key.lower().startswith("utm_")
        and key.lower() not in {"fbclid", "gclid"}
    ]
    return urllib.parse.urlunsplit((
        parsed.scheme.lower(), parsed.netloc.lower(), parsed.path,
        urllib.parse.urlencode(sorted(query)), ""
    ))


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def fingerprint(row):
    # This is an RSS metadata fingerprint, not a fingerprint of article text.
    values = [row["title"], row["source"], row["published_at"]]
    return digest(json.dumps(values, ensure_ascii=False))


def feed_url(name):
    query = urllib.parse.urlencode({
        "q": f'"{name}" when:{QUERY_DAYS}d',
        "hl": "zh-TW", "gl": "TW", "ceid": "TW:zh-Hant"
    })
    return "https://news.google.com/rss/search?" + query


def parse_feed(raw, now):
    if len(raw) > MAX_BYTES:
        raise ValueError("RSS exceeds size limit")
    if re.search(br"<!\s*(DOCTYPE|ENTITY)", raw, re.I):
        raise ValueError("DTD and ENTITY are not accepted")

    root = ET.fromstring(raw)
    if root.tag != "rss" or root.find("channel") is None:
        raise ValueError("Not a valid RSS channel")

    rows = []
    nodes = root.findall("./channel/item")
    skipped = 0
    for node in nodes:
        title = clean(node.findtext("title"))
        source = clean(node.findtext("source")) or "來源未提供"
        if title.endswith(" - " + source):
            title = title[:-(len(source) + 3)].strip()
        people = [key for key, name in PEOPLE.items() if name in title]
        link = safe_url(node.findtext("link"))

        try:
            published = parsedate_to_datetime(node.findtext("pubDate") or "")
            if published.tzinfo is None:
                raise ValueError("Publication time has no timezone")
            published = published.astimezone(timezone.utc)
        except (TypeError, ValueError, OverflowError):
            skipped += 1
            continue

        if (not title or not link or not people
                or published > now + timedelta(hours=24)
                or published < now - timedelta(days=RETENTION_DAYS)):
            skipped += 1
            continue

        row = {
            "id": digest(canonical(link))[:24],
            "title": title,
            "source": source,
            "url": link,
            "people": people,
            "published_at": stamp(published)
        }
        row["fingerprint"] = fingerprint(row)
        rows.append(row)

    return rows, len(nodes), skipped


def coverage_gap(previous, now):
    prior = previous.get("last_success_at")
    if not prior:
        return None
    try:
        elapsed = now - parse_time(prior)
    except (TypeError, ValueError):
        return None
    if elapsed > timedelta(days=QUERY_DAYS):
        return {
            "from": prior,
            "detected_at": stamp(now),
            "message": "來源中斷超過查詢窗口，期間文章可能未收錄，且未自動回補。"
        }
    return previous.get("coverage_gap")


def fetch_one(key, name, previous, now):
    url = feed_url(name)
    headers = {
        "User-Agent": "TaipeiEvidenceTracker/1.0",
        "Accept": "application/rss+xml, application/xml;q=0.9"
    }
    if previous.get("etag"):
        headers["If-None-Match"] = previous["etag"]
    if previous.get("last_modified"):
        headers["If-Modified-Since"] = previous["last_modified"]

    last_error = "unknown"
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers=headers)
            try:
                response = urllib.request.urlopen(request, timeout=20)
            except urllib.error.HTTPError as error:
                if error.code != 304:
                    raise
                health = dict(previous)
                health.update({
                    "name": name, "url": url, "status": "not_modified",
                    "last_attempt_at": stamp(now), "last_success_at": stamp(now),
                    "error": None
                })
                gap = coverage_gap(previous, now)
                if gap:
                    health["coverage_gap"] = gap
                return key, [], health

            with response:
                raw = response.read(MAX_BYTES + 1)
                rows, raw_count, skipped = parse_feed(raw, now)
                health = {
                    "name": name, "url": url,
                    "status": "ok" if rows else "ok_empty",
                    "last_attempt_at": stamp(now),
                    "last_success_at": stamp(now),
                    "last_nonempty_at": stamp(now) if rows else previous.get("last_nonempty_at"),
                    "raw_count": raw_count,
                    "accepted_count": len(rows),
                    "skipped_count": skipped,
                    "etag": response.headers.get("ETag"),
                    "last_modified": response.headers.get("Last-Modified"),
                    "error": None
                }
            gap = coverage_gap(previous, now)
            if gap:
                health["coverage_gap"] = gap
            return key, rows, health
        except (urllib.error.URLError, TimeoutError, ValueError,
                ET.ParseError, OSError) as error:
            last_error = type(error).__name__
            if attempt < 2:
                time.sleep(2 ** attempt)

    health = dict(previous)
    health.update({
        "name": name, "url": url, "status": "failed",
        "last_attempt_at": stamp(now), "error": last_error
    })
    gap = coverage_gap(previous, now)
    if gap:
        health["coverage_gap"] = gap
    return key, [], health


def collect(previous, now=None):
    now = now or datetime.now(timezone.utc)
    existing = {row["id"]: dict(row) for row in previous.get("articles", [])}
    old_feeds = previous.get("feeds", {})
    feeds = {}

    with ThreadPoolExecutor(max_workers=2) as executor:
        jobs = [executor.submit(fetch_one, key, name, old_feeds.get(key, {}), now)
                for key, name in PEOPLE.items()]
        for job in jobs:
            key, rows, health = job.result()
            feeds[key] = health
            for row in rows:
                old = existing.get(row["id"], {})
                history = list(old.get("history", []))
                if old and old.get("fingerprint") != row["fingerprint"]:
                    history.append({
                        "title": old["title"],
                        "fingerprint": old.get("fingerprint"),
                        "replaced_at": stamp(now)
                    })
                row.update({
                    "first_seen_at": old.get("first_seen_at", stamp(now)),
                    "last_seen_at": stamp(now),
                    "history": history[-5:]
                })
                existing[row["id"]] = row

    cutoff = now - timedelta(days=RETENTION_DAYS)
    articles = [row for row in existing.values()
                if parse_time(row["published_at"]) >= cutoff]
    articles.sort(key=lambda row: row["published_at"], reverse=True)
    successes = sum(feed["status"] != "failed" for feed in feeds.values())

    return {
        "version": 1,
        "status": "ok" if successes == len(PEOPLE) else "partial" if successes else "failed",
        "last_attempt_at": stamp(now),
        "retention_days": RETENTION_DAYS,
        "query_days": QUERY_DAYS,
        "feeds": feeds,
        "articles": articles
    }


def validate_reviews(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        raise ValueError("reviews.json must contain an items array")
    ids = set()
    verdicts = {"supported", "false", "misleading", "opinion", "unresolved"}
    scopes = {"candidate", "team", "third_party", "unknown"}
    directions = {"jiang_to_shen", "shen_to_jiang", "other", "none"}
    for review in payload["items"]:
        required = ["id", "article_id", "fingerprint", "claim", "note",
                    "reviewer", "reviewed_at", "status", "verdict",
                    "speaker_scope", "direction", "negative", "evidence"]
        if not isinstance(review, dict) or any(key not in review for key in required):
            raise ValueError("Manual review is missing required fields")
        if review["id"] in ids:
            raise ValueError("Duplicate manual review id")
        ids.add(review["id"])
        if review["status"] not in {"draft", "published", "withdrawn"}:
            raise ValueError("Invalid review status")
        if review["verdict"] not in verdicts or review["speaker_scope"] not in scopes:
            raise ValueError("Invalid review verdict or speaker scope")
        if review["direction"] not in directions or type(review["negative"]) is not bool:
            raise ValueError("Invalid direction or negative flag")
        parse_time(review["reviewed_at"])
        if not isinstance(review["evidence"], list) or any(not safe_url(url) for url in review["evidence"]):
            raise ValueError("Review evidence must contain valid HTTP(S) URLs")
        if review["status"] == "published":
            if not review["evidence"]:
                raise ValueError("Published reviews require evidence")
            if any(not str(review[key]).strip() for key in ["claim", "note", "reviewer", "fingerprint"]):
                raise ValueError("Published reviews require claim, note, reviewer, and fingerprint")


def validate_profiles(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("people"), list):
        raise ValueError("profiles.json must contain a people array")
    seen = set()
    for person in payload["people"]:
        if person.get("id") not in PEOPLE or person["id"] in seen:
            raise ValueError("Invalid or duplicate profile person id")
        seen.add(person["id"])
        if not isinstance(person.get("facts"), list):
            raise ValueError("Profile facts must be an array")
        for fact in person["facts"]:
            if any(not str(fact.get(key, "")).strip()
                   for key in ["label", "value", "reviewer", "reviewed_at"]):
                raise ValueError("Profile fact is missing required fields")
            parse_time(fact["reviewed_at"])
            evidence = fact.get("evidence")
            if not isinstance(evidence, list) or not evidence or any(not safe_url(url) for url in evidence):
                raise ValueError("Profile facts require valid evidence URLs")


def validate_events(payload):
    if (not isinstance(payload, dict) or payload.get("version") != 1
            or not isinstance(payload.get("items"), list)):
        raise ValueError("events.json must contain version 1 and an items array")
    ids = set()
    for event in payload["items"]:
        required = ["id", "title", "summary", "article_ids", "evidence",
                    "reviewer", "confirmed_at", "revisions"]
        if not isinstance(event, dict) or any(key not in event for key in required):
            raise ValueError("Confirmed event is missing required fields")
        if not all(isinstance(event[key], str) and event[key].strip()
                   for key in ["id", "title", "summary", "reviewer"]):
            raise ValueError("Confirmed event has empty required text")
        if event["id"] in ids:
            raise ValueError("Duplicate confirmed event id")
        ids.add(event["id"])
        if not isinstance(event["article_ids"], list) or any(
                not isinstance(value, str) or not value.strip()
                for value in event["article_ids"]):
            raise ValueError("Confirmed event article_ids must be strings")
        if not isinstance(event["evidence"], list) or not event["evidence"] or any(
                not safe_url(url) for url in event["evidence"]):
            raise ValueError("Confirmed events require valid evidence URLs")
        parse_time(event["confirmed_at"])
        if not isinstance(event["revisions"], list):
            raise ValueError("Confirmed event revisions must be an array")
        for revision in event["revisions"]:
            if not isinstance(revision, dict) or any(
                    not str(revision.get(key, "")).strip()
                    for key in ["note", "reviewer", "revised_at"]):
                raise ValueError("Event revision is missing required fields")
            parse_time(revision["revised_at"])
            evidence = revision.get("evidence", [])
            if not isinstance(evidence, list) or any(not safe_url(url) for url in evidence):
                raise ValueError("Event revision evidence must contain valid HTTP(S) URLs")
