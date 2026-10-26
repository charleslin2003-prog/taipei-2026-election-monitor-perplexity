import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from collect import (
    canonical, collect, coverage_gap, parse_feed, safe_url,
    validate_events, validate_reviews
)

NOW = datetime(2026, 10, 26, tzinfo=timezone.utc)
FIXTURE = b"""<rss><channel><item>
<title>TEST</title><link>https://example.org/test</link>
<source>TEST SOURCE</source>
<pubDate>Sun, 25 Oct 2026 12:00:00 GMT</pubDate>
</item></channel></rss>"""


class CollectorTests(unittest.TestCase):
    def test_reject_unsafe_urls(self):
        self.assertEqual(safe_url("javascript:alert(1)"), "")
        self.assertEqual(safe_url("https://user:pass@example.org/"), "")

    def test_normalize_tracking_query(self):
        self.assertEqual(
            canonical("https://example.org/a?utm_source=x&id=2#part"),
            "https://example.org/a?id=2"
        )

    def test_empty_feed_is_valid(self):
        self.assertEqual(parse_feed(b"<rss><channel/></rss>", NOW), ([], 0, 0))

    def test_unrelated_title_is_skipped(self):
        self.assertEqual(parse_feed(FIXTURE, NOW), ([], 1, 1))

    def test_reject_non_rss_xml(self):
        with self.assertRaises(Exception):
            parse_feed(b"<html>not rss</html>", NOW)

    def test_reject_entity_declaration(self):
        with self.assertRaises(ValueError):
            parse_feed(b'<!DOCTYPE rss [<!ENTITY x "x">]><rss><channel/></rss>', NOW)

    def test_detect_possible_collection_gap(self):
        previous = {"last_success_at": "2026-10-01T00:00:00+00:00"}
        self.assertIsNotNone(coverage_gap(previous, NOW))
        self.assertIsNone(coverage_gap({}, NOW))

    def test_failed_fetch_preserves_old_article(self):
        article = {
            "id": "offline-test", "title": "offline fixture", "source": "test",
            "url": "https://example.org/test", "people": ["jiang"],
            "published_at": "2026-10-25T00:00:00+00:00", "fingerprint": "fixture"
        }

        def failed(key, name, previous, now):
            return key, [], {"name": name, "status": "failed", "error": "offline test"}

        with patch("collect.fetch_one", side_effect=failed):
            result = collect({"articles": [article]}, NOW)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["articles"][0]["id"], "offline-test")

    def test_partial_fetch_status_preserves_unavailable_source_data(self):
        article = {
            "id": "offline-test", "title": "offline fixture", "source": "test",
            "url": "https://example.org/test", "people": ["jiang"],
            "published_at": "2026-10-25T00:00:00+00:00", "fingerprint": "fixture"
        }

        def mixed(key, name, previous, now):
            if key == "jiang":
                return key, [], {"name": name, "status": "failed", "error": "offline test"}
            return key, [], {"name": name, "status": "ok_empty", "error": None}

        with patch("collect.fetch_one", side_effect=mixed):
            result = collect({"articles": [article]}, NOW)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["articles"][0]["id"], "offline-test")

    def test_empty_reviews_are_valid(self):
        validate_reviews({"items": []})

    def test_published_review_requires_evidence(self):
        review = {
            "id": "test", "article_id": "article", "fingerprint": "test",
            "claim": "test", "note": "test", "reviewer": "test",
            "reviewed_at": "2026-10-26T00:00:00Z", "status": "published",
            "verdict": "unresolved", "speaker_scope": "unknown",
            "direction": "none", "negative": False, "evidence": []
        }
        with self.assertRaises(ValueError):
            validate_reviews({"items": [review]})

    def test_empty_confirmed_events_are_valid(self):
        validate_events({"version": 1, "items": []})

    def test_confirmed_event_requires_evidence_and_revision_history(self):
        event = {
            "id": "test-event", "title": "test", "summary": "test",
            "article_ids": ["article"], "evidence": ["https://example.org/evidence"],
            "reviewer": "reviewer", "confirmed_at": "2026-10-26T00:00:00Z",
            "revisions": [{"note": "corrected", "reviewer": "reviewer",
                           "revised_at": "2026-10-26T00:00:00Z",
                           "evidence": ["https://example.org/revision"]}]
        }
        validate_events({"version": 1, "items": [event]})
        event["evidence"] = []
        with self.assertRaises(ValueError):
            validate_events({"version": 1, "items": [event]})


if __name__ == "__main__":
    unittest.main()
