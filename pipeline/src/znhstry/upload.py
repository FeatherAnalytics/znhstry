"""Push the export to Cloudflare R2 with the headers it depends on.

boto3 rather than the AWS CLI, matching how the other projects in this account
talk to R2: `uv` already provides the Python, so there is nothing to install on
a developer's machine and nothing to special-case on Windows.

Two headers do all the work, and neither can be set by a static site host,
which is why the payloads live here rather than in the site bundle:

    Content-Encoding: br    Everything is stored brotli-compressed and the
                            browser unwraps it, so the client carries no
                            decoding code at all.
    Cache-Control           Per object, and only `immutable` where that is
                            actually true - see `_cache_control`. Shard names
                            are stable, so anything a nightly run rewrites must
                            be allowed to revalidate or a returning reader keeps
                            yesterday's map for a year.

Upload order is deliberate: shards first, manifests last. Until the manifest
lands, clients are still reading the previous one, and every file it names is
still in place.

Set ZNHSTRY_UPLOAD_FORCE=1 to re-send every object regardless of its ETag. Only
needed to restamp headers on objects whose bytes have not changed, since the
content check would otherwise skip them and leave the old Cache-Control behind.
"""

from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor
from hashlib import md5
from datetime import date
from pathlib import Path

from . import config

log = logging.getLogger(__name__)

IMMUTABLE = "public, max-age=31536000, immutable"
MANIFEST = "public, max-age=60"

# For everything a nightly run can rewrite under a name it already used.
#
# `immutable` is a promise that the bytes at a URL will never change, and the
# browser holds a promise for the full year without ever asking again - a hard
# reload does not override it. Marking a shard that churns as immutable means a
# returning reader keeps yesterday's map forever.
#
# Five minutes, then revalidate. A 304 carries no body, so the cost of being
# wrong is a header exchange rather than a re-download.
VOLATILE = "public, max-age=300, must-revalidate"

# Positions, names and lookups describe where places are and what they are
# called. They are rewritten byte-identically every run and genuinely never
# change, so they keep the year-long promise.
_IMMUTABLE_TREES = ("tiles/", "terrain/", "names/")
_IMMUTABLE_FILES = ("zone_ids.bin.br", "lookups.json.br")


def _cache_control(key: str) -> str:
    """How long this object may be trusted without asking again.

    Immutable only where it is true. `paint/` is state as of now; the current
    year's display shard grows daily; `zone_history/` blocks are rewritten
    wherever a zone moved; the series are recomputed in full. All of those keep
    their filenames, so the only thing standing between a reader and stale data
    is this header.
    """
    name = key.rsplit("/", 1)[-1]
    if name == "meta.json":
        return MANIFEST
    if name.startswith("boundaries") or name in _IMMUTABLE_FILES:
        return IMMUTABLE
    if any(f"/{tree}" in f"/{key}" for tree in _IMMUTABLE_TREES):
        return IMMUTABLE

    # A past year's display shard and anchor are finished history. The current
    # year's shard gains rows every night, so it is volatile until the year ends.
    if "/display/" in f"/{key}":
        digits = "".join(c for c in name if c.isdigit())
        year = int(digits[:4]) if len(digits) >= 4 else 0
        return IMMUTABLE if 0 < year < date.today().year else VOLATILE

    return VOLATILE

# A full export is ~1,850 small objects. Serial puts would take many minutes of
# almost pure round-trip; R2 is happy with this much concurrency.
WORKERS = 16


def _client():
    """An S3 client pointed at R2, from whichever env var names are set."""
    account = os.environ.get("R2_ACCOUNT_ID")
    endpoint = os.environ.get("R2_ENDPOINT") or (
        f"https://{account}.r2.cloudflarestorage.com" if account else None
    )
    access_key = os.environ.get("R2_ACCESS_KEY_ID") or os.environ.get("AWS_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY") or os.environ.get(
        "AWS_SECRET_ACCESS_KEY"
    )

    if not (endpoint and access_key and secret_key):
        raise SystemExit(
            "R2 credentials not set. Need R2_ACCOUNT_ID (or R2_ENDPOINT), "
            "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY. See .env.example."
        )

    import boto3

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )


def _content_type(path: Path) -> str:
    # "a.json.br" is a brotli stream over JSON, so the type is the inner one;
    # the encoding header carries the rest.
    inner = path.name[:-3] if path.suffix == ".br" else path.name
    return "application/json" if inner.endswith(".json") else "application/octet-stream"


def _put(s3, bucket: str, path: Path, key: str) -> int:
    body = path.read_bytes()
    extra = {}
    if path.suffix == ".br":
        extra["ContentEncoding"] = "br"
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType=_content_type(path),
        CacheControl=_cache_control(key),
        **extra,
    )
    return len(body)


def _existing(s3, bucket: str) -> dict[str, str]:
    """Every key in the bucket, mapped to its ETag with the quotes stripped.

    For an object written by a single `put_object` - which is all of them, the
    largest shard being a few MB - R2's ETag is the MD5 of the body in hex. That
    makes it a free content check: the listing is one request per 1,000 objects
    and we were already paying for it to find orphans.
    """
    found: dict[str, str] = {}
    token = None
    while True:
        kwargs = {"Bucket": bucket, "MaxKeys": 1000}
        if token:
            kwargs["ContinuationToken"] = token
        page = s3.list_objects_v2(**kwargs)
        for item in page.get("Contents", []):
            found[item["Key"]] = item.get("ETag", "").strip('"')
        if not page.get("IsTruncated"):
            return found
        token = page.get("NextContinuationToken")


def upload_all(source: Path | None = None, bucket: str | None = None) -> None:
    source = source or config.WEB_DATA
    bucket = bucket or os.environ.get("R2_BUCKET") or os.environ.get("R2_BUCKET_NAME")
    if not bucket:
        raise SystemExit("Set R2_BUCKET (or R2_BUCKET_NAME).")
    if not source.exists():
        raise SystemExit(f"{source} does not exist - run `znhstry export` first.")

    s3 = _client()

    files = sorted(p for p in source.rglob("*") if p.is_file())
    # Manifests last: a client that reads one must find every shard it names.
    manifests = [p for p in files if p.name.endswith(".json") and p.suffix != ".br"]
    shards = [p for p in files if p not in set(manifests)]
    key_of = {p: p.relative_to(source).as_posix() for p in files}

    remote = _existing(s3, bucket)

    # Most of the export never changes. Positions, names, lookups and zone ids
    # describe where places are and what they are called; the export rewrites
    # them every run, byte for byte identically, and sending them again is pure
    # waste - about 21 MB and 800 objects a night. Skipping on a matching ETag
    # also means a re-upload after an interrupted run costs almost nothing.
    # The skip compares bodies, not headers, so an object whose Cache-Control
    # policy changed but whose bytes did not would keep the old header forever.
    # That is what the force flag is for.
    force = os.environ.get("ZNHSTRY_UPLOAD_FORCE") == "1"

    def unchanged(path: Path) -> bool:
        if force:
            return False
        etag = remote.get(key_of[path])
        return etag is not None and etag == md5(path.read_bytes()).hexdigest()

    pending = [p for p in shards if not unchanged(p)]
    skipped = len(shards) - len(pending)

    log.info(
        "uploading %s objects to %s (%s unchanged, skipped)",
        f"{len(pending) + len(manifests):,}",
        bucket,
        f"{skipped:,}",
    )

    done = 0
    total_bytes = 0

    def send(path: Path) -> int:
        return _put(s3, bucket, path, key_of[path])

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for size in pool.map(send, pending):
            done += 1
            total_bytes += size
            if done % 250 == 0:
                log.info("  %s / %s", f"{done:,}", f"{len(pending):,}")

    # Orphans from a previous layout. Deleted after the new shards are all in
    # place and before the manifest names them, so no client sees a gap.
    stale = set(remote) - set(key_of.values())
    if stale:
        log.info("removing %s orphaned objects", f"{len(stale):,}")
        batch = sorted(stale)
        for i in range(0, len(batch), 1000):
            s3.delete_objects(
                Bucket=bucket,
                Delete={"Objects": [{"Key": k} for k in batch[i : i + 1000]]},
            )

    # The manifest always goes, even when identical: it is the cheap file, and
    # a client that finds a stale one finds shards that no longer exist.
    for path in manifests:
        total_bytes += send(path)

    log.info(
        "upload complete: %s sent, %s skipped, %s MB",
        f"{len(pending) + len(manifests):,}",
        f"{skipped:,}",
        f"{total_bytes / 1e6:.1f}",
    )
