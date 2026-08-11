"""The upload refuses an export that did not finish.

`upload_all` treats the files on disk as the complete list of live objects and deletes
every bucket key they do not name. That is only safe while the export is whole. An
export killed part way leaves new shards under the previous run's manifest, and
uploading it publishes a manifest that names files nobody wrote and sweeps away the
ones that are still being served.

`export_all` writes `meta.json` last, so the manifest being the newest file in its own
tree is what a finished run looks like from outside.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from znhstry.upload import _refuse_a_half_written_export


def _export(tmp_path: Path, manifest_ns: int, shard_ns: int) -> tuple[Path, list[Path]]:
    """An export tree whose manifest and shard have the given modification times."""
    tree = tmp_path / "data" / "global"
    shard = tree / "display" / "2026.bin.br"
    shard.parent.mkdir(parents=True)
    shard.write_bytes(b"shard")
    manifest = tree / "meta.json"
    manifest.write_text("{}", encoding="utf-8")

    os.utime(shard, ns=(shard_ns, shard_ns))
    os.utime(manifest, ns=(manifest_ns, manifest_ns))

    source = tmp_path / "data"
    return source, sorted(p for p in source.rglob("*") if p.is_file())


def test_a_finished_export_uploads(tmp_path):
    source, files = _export(tmp_path, manifest_ns=2_000_000_000, shard_ns=1_000_000_000)
    _refuse_a_half_written_export(source, files)


def test_a_shard_newer_than_the_manifest_stops_the_upload(tmp_path):
    source, files = _export(tmp_path, manifest_ns=1_000_000_000, shard_ns=2_000_000_000)
    with pytest.raises(SystemExit, match="did not finish"):
        _refuse_a_half_written_export(source, files)


def test_a_tree_with_no_manifest_stops_the_upload(tmp_path):
    source, files = _export(tmp_path, manifest_ns=1_000_000_000, shard_ns=1_000_000_000)
    (source / "global" / "meta.json").unlink()
    with pytest.raises(SystemExit, match="has not finished"):
        _refuse_a_half_written_export(source, [p for p in files if p.name != "meta.json"])
