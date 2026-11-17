"""Run the actual verifier with in-memory corruptions; never change project data."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]


class VerifierFaultInjection(unittest.TestCase):
    def verify_rejected(self, mutation, manifest="kaoyan_706_manifest.json", track="track1", sentence_json=False):
        real_load = json.load
        mutated = False

        def load(stream, *args, **kwargs):
            nonlocal mutated
            data = real_load(stream, *args, **kwargs)
            name = Path(stream.name).name
            if not mutated and ((sentence_json and name.endswith(".sentences.json")) or
                                (not sentence_json and name == manifest)):
                if sentence_json:
                    mutation(data)
                else:
                    item = data[0]
                    soup = BeautifulSoup(item[track]["html"], "html.parser")
                    mutation(soup)
                    item[track]["html"] = str(soup)
                mutated = True
            return data

        output = io.StringIO()
        with patch.object(json, "load", load), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as error:
                runpy.run_path(str(ROOT / "verify_all_sync.py"), run_name="__main__")
        self.assertTrue(mutated)
        self.assertEqual(error.exception.code, 1, output.getvalue())
        self.assertIn("ISSUES", output.getvalue())

    def test_removed_sentence_attribute(self):
        self.verify_rejected(lambda soup: soup.find(attrs={"data-sent-id": True}).attrs.pop("data-sent-id"))

    def test_removed_sentence_node(self):
        self.verify_rejected(lambda soup: soup.find(attrs={"data-sent-id": True}).decompose())

    def test_duplicate_primary_sentence(self):
        def duplicate(soup):
            first = soup.find(attrs={"data-sent-id": True})
            first.insert_after(BeautifulSoup(str(first), "html.parser"))
        self.verify_rejected(duplicate)

    def test_linked_quote_does_not_hide_missing_track2_primary(self):
        self.verify_rejected(lambda soup: soup.select_one('[data-sent-id]:not(.t1-linked-sent)').decompose(), track="track2")

    def test_duplicate_json_sentence(self):
        self.verify_rejected(lambda sentences: sentences.append(dict(sentences[0])), sentence_json=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
