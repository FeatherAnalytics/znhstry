"""The half-hourly marts publish must leave every other mart exactly as it found it.

This run's warehouse holds five of the marts, so the bucket is the only record of the rest.
A sweep, or a manifest rebuilt from what is on disk, would remove them from the console and
the MCP server while every file and every run still looked healthy.
"""

from __future__ import annotations

import io
import json
from hashlib import md5
from pathlib import Path

import pytest
from botocore.exceptions import ClientError

from znhstry import config
from znhstry.upload import MARTS_MANIFEST_KEY, MARTS_PREFIX, upload_live_atlantis_marts


class FakeR2:
    """The calls the upload makes, with R2's If-Match behavior and a log of every write."""

    def __init__(self, objects: dict[str, bytes], before_conditional_put=None):
        self.objects = dict(objects)
        self.writes: list[str] = []
        self.deletes: list[dict] = []
        self._before_conditional_put = before_conditional_put

    def _etag(self, key: str) -> str:
        return md5(self.objects[key]).hexdigest()

    def get_object(self, Bucket, Key):  # noqa: N803
        return {"Body": io.BytesIO(self.objects[Key]), "ETag": f'"{self._etag(Key)}"'}

    def list_objects_v2(self, Bucket, MaxKeys, Prefix=""):  # noqa: N803
        keys = [k for k in self.objects if k.startswith(Prefix)]
        return {"Contents": [{"Key": k, "ETag": f'"{self._etag(k)}"'} for k in keys]}

    def put_object(self, Bucket, Key, Body, IfMatch=None, **_):  # noqa: N803
        if IfMatch is not None:
            if self._before_conditional_put:
                hook, self._before_conditional_put = self._before_conditional_put, None
                hook(self)
            if IfMatch != f'"{self._etag(Key)}"':
                raise ClientError(
                    {
                        "Error": {"Code": "PreconditionFailed"},
                        "ResponseMetadata": {"HTTPStatusCode": 412},
                    },
                    "PutObject",
                )
        self.objects[Key] = Body
        self.writes.append(Key)

    def delete_objects(self, **kwargs):
        self.deletes.append(kwargs)


def _published() -> dict:
    tables = {name: {"path": f"{name}.parquet", "rows": 1} for name in config.LIVE_ATLANTIS_MARTS}
    tables["fct_zone_events"] = {"path": "fct_zone_events.parquet", "rows": 9}
    return {"newest_event_date": "2026-11-04", "future_key": 1, "tables": tables}


def _bucket(manifest: bytes) -> dict[str, bytes]:
    objects = {MARTS_PREFIX + f"{n}.parquet": b"old" for n in config.LIVE_ATLANTIS_MARTS}
    objects[MARTS_PREFIX + "fct_zone_events.parquet"] = b"untouched"
    objects[MARTS_MANIFEST_KEY] = manifest
    return objects


def _run(tmp_path: Path, monkeypatch, s3: FakeR2) -> None:
    for name in config.LIVE_ATLANTIS_MARTS:
        (tmp_path / f"{name}.parquet").write_bytes(b"new")
    entries = {n: {"path": f"{n}.parquet", "rows": 2} for n in config.LIVE_ATLANTIS_MARTS}
    (tmp_path / config.LIVE_ATLANTIS_ENTRIES).write_text(json.dumps(entries), encoding="utf-8")
    monkeypatch.setattr("znhstry.upload._client", lambda: s3)
    upload_live_atlantis_marts(tmp_path, "bucket")


def test_writes_only_the_live_marts_then_the_manifest_and_deletes_nothing(tmp_path, monkeypatch):
    s3 = FakeR2(_bucket(json.dumps(_published()).encode()))

    _run(tmp_path, monkeypatch, s3)

    assert s3.deletes == []
    assert s3.writes[-1] == MARTS_MANIFEST_KEY
    assert set(s3.writes[:-1]) == {
        MARTS_PREFIX + f"{n}.parquet" for n in config.LIVE_ATLANTIS_MARTS
    }
    assert s3.objects[MARTS_PREFIX + "fct_zone_events.parquet"] == b"untouched"


def test_patch_keeps_everything_else_including_a_nightly_landing_mid_write(tmp_path, monkeypatch):
    def nightly_writes(s3: FakeR2) -> None:
        newer = _published()
        newer["newest_event_date"] = "2026-11-05"
        newer["tables"]["fct_zone_events"]["rows"] = 10
        s3.objects[MARTS_MANIFEST_KEY] = json.dumps(newer).encode()

    s3 = FakeR2(_bucket(json.dumps(_published()).encode()), nightly_writes)

    _run(tmp_path, monkeypatch, s3)

    written = json.loads(s3.objects[MARTS_MANIFEST_KEY])
    assert written["newest_event_date"] == "2026-11-05"
    assert written["future_key"] == 1
    assert written["tables"]["fct_zone_events"] == {"path": "fct_zone_events.parquet", "rows": 10}
    assert all(written["tables"][n]["rows"] == 2 for n in config.LIVE_ATLANTIS_MARTS)


@pytest.mark.parametrize(
    "manifest",
    [b"<html>not json</html>", b'{"newest_event_date": "2026-11-04", "tables": {}}', None],
    ids=["unparsable", "lacks-a-table", "unreadable"],
)
def test_a_manifest_it_cannot_patch_stops_before_any_write(tmp_path, monkeypatch, manifest):
    objects = _bucket(manifest or b"")
    if manifest is None:
        del objects[MARTS_MANIFEST_KEY]
    s3 = FakeR2(objects)

    with pytest.raises((SystemExit, ValueError, KeyError)):
        _run(tmp_path, monkeypatch, s3)

    assert s3.writes == []
