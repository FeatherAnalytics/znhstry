"""A download that does not match the manifest's MD5 must never land in `data/raw`.

The credential-free restore has no listing and no ETag to lean on, only the manifest the
archive wrote. A truncated Parquet body is still a Parquet body: it decodes into plausible
rows for however many arrived, and `dbt build` runs green over a record with a hole in it.
"""

from __future__ import annotations

from hashlib import md5

import httpx
import pytest

from znhstry import config, upload


def _client(files: dict[str, bytes], manifest: dict[str, str]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/")
        if path == upload.MANIFEST_KEY:
            return httpx.Response(200, json={"files": manifest})
        body = files.get(path.removeprefix(upload.ARCHIVE_PREFIX))
        return httpx.Response(200, content=body) if body is not None else httpx.Response(404)

    return httpx.Client(transport=httpx.MockTransport(handler), base_url="https://example.test")


def test_a_body_that_fails_its_md5_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "RAW", tmp_path)
    monkeypatch.setattr(config, "PUBLIC_DATA_ORIGIN", "https://example.test")
    whole = b"PAR1 the whole file"
    truncated = {"zones/zones.parquet": whole[:5]}
    manifest = {"zones/zones.parquet": md5(whole).hexdigest()}

    with pytest.raises(SystemExit, match="does not match"):
        upload._restore_public("", client=_client(truncated, manifest))

    assert not (tmp_path / "zones" / "zones.parquet").exists()
