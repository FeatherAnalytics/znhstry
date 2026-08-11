"""Push the export to Cloudflare R2 with the headers it depends on.

boto3 rather than the AWS CLI, matching how the other projects in this account
talk to R2: `uv` already provides the Python, so there is nothing to install on
a developer's machine and nothing to special-case on Windows.

Two headers do all the work, and neither can be set by a static site host,
which is why the payloads live here rather than in the site bundle:

    Content-Encoding: br    Everything is stored brotli-compressed and the
                            browser unwraps it, so the client carries no
                            decoding code at all.
    Cache-Control           One rule: revalidate. Shard names are stable and a
                            nightly run rewrites them, so a browser must ask
                            before reusing - see `_cache_control`.

Upload order is deliberate: shards first, manifests last, and only then the
orphan sweep. Until the manifest lands, clients are still reading the previous
one, and every file it names is still in place - including the keys the sweep
is about to remove, which is why it goes after the manifest rather than before.

Set ZNHSTRY_UPLOAD_FORCE=1 to re-send every object regardless of its ETag. Only
needed to restamp headers on objects whose bytes have not changed, since the
content check would otherwise skip them and leave the old Cache-Control behind.
"""

from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor
from hashlib import md5
from pathlib import Path

from . import config

log = logging.getLogger(__name__)

# One rule for everything, and it is deliberately the boring one.
#
# `immutable` promises a browser the bytes at a URL will never change and licenses it
# to skip revalidation for a year - not even a hard reload overrides it. The promise
# was false. Roughly 24,000 zones a year are played for the first time and `zone_ids`
# grows whenever a zone appears, so the files marked immutable did change, while
# `meta.json` refreshed every minute. Readers paired a fresh manifest with year-old
# shards, the row counts disagreed, and whole regions of the map silently vanished.
#
# The fix is not to work out which files are *really* immutable. That is a judgement
# call made once and then quietly invalidated by the next change - it is exactly the
# judgement that failed here. `no-cache` does not mean "do not cache": it means "ask
# before reusing". The browser keeps the body and revalidates against the ETag, so an
# unchanged shard costs a header exchange and a 304 with no body at all.
#
# R2 returns the MD5 as the ETag for every object, so this works by itself and needs
# nothing in the manifest to support it.
REVALIDATE = "public, no-cache"

# The raw layer's home in the same bucket. It is not part of the export and no
# browser ever asks for it, but it shares the bucket because a second one would
# mean a second set of credentials for no benefit - the data is QONQR's public
# record either way, and having it fetchable is what lets anyone clone this repo
# and rebuild the whole warehouse without a single upstream request.
#
# Load-bearing: `upload_all` deletes every key the export does not name, so
# without fencing this prefix off, publishing the site would wipe the archive.
ARCHIVE_PREFIX = "raw/"
ARCHIVE = "no-store"


def _cache_control(key: str) -> str:
    """How long this object may be trusted without asking again: never, without asking.

    Deliberately one answer for every object. Deciding per tree means deciding which
    files really never change, and that judgement is what broke the map - see the note
    on REVALIDATE. The raw archive is the one exception: no browser fetches it.
    """
    if key.startswith(ARCHIVE_PREFIX):
        return ARCHIVE
    return REVALIDATE


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
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY") or os.environ.get("AWS_SECRET_ACCESS_KEY")

    if not (endpoint and access_key and secret_key):
        raise SystemExit(
            "R2 credentials not set. Need R2_ACCOUNT_ID (or R2_ENDPOINT), "
            "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY. See .env.example."
        )

    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        # botocore pools 10 connections by default and we run 16 threads, so the
        # surplus six spend the run opening a socket, being discarded on return,
        # and opening another. Matching the pool to the workers is the whole fix.
        config=Config(max_pool_connections=WORKERS),
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


def _bucket(name: str | None = None) -> str:
    name = name or os.environ.get("R2_BUCKET") or os.environ.get("R2_BUCKET_NAME")
    if not name:
        raise SystemExit("Set R2_BUCKET (or R2_BUCKET_NAME).")
    return name


def archive_raw(bucket: str | None = None) -> None:
    """Push `data/raw` to the bucket under `raw/`.

    This is the durable copy. Once the nightly reads Dropbox instead of the SQL
    mirror, the ring only reaches back 31 days, so everything before that exists
    solely because we kept it - an Actions cache is evictable and a laptop is a
    laptop. The ETag skip means a nightly archive sends the year partition that
    changed and the ~200 MB that did not stays put.
    """
    bucket = _bucket(bucket)
    if not config.RAW.exists():
        raise SystemExit(f"{config.RAW} does not exist - nothing to archive.")

    s3 = _client()
    files = sorted(p for p in config.RAW.rglob("*") if p.is_file() and p.suffix != ".tmp")
    key_of = {p: ARCHIVE_PREFIX + p.relative_to(config.RAW).as_posix() for p in files}
    remote = _existing(s3, bucket)

    force = os.environ.get("ZNHSTRY_UPLOAD_FORCE") == "1"
    pending = [
        p for p in files if force or remote.get(key_of[p]) != md5(p.read_bytes()).hexdigest()
    ]

    log.info(
        "archiving %s of %s files (%s MB)",
        f"{len(pending):,}",
        f"{len(files):,}",
        f"{sum(p.stat().st_size for p in pending) / 1e6:.1f}",
    )

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        list(pool.map(lambda p: _put(s3, bucket, p, key_of[p]), pending))

    # Only within the archive's own prefix, so this can never touch the export.
    stale = {k for k in remote if k.startswith(ARCHIVE_PREFIX)} - set(key_of.values())
    if stale:
        log.info("removing %s stale archive objects", f"{len(stale):,}")
        batch = sorted(stale)
        for i in range(0, len(batch), 1000):
            s3.delete_objects(
                Bucket=bucket, Delete={"Objects": [{"Key": k} for k in batch[i : i + 1000]]}
            )

    log.info("archive complete: %s files under %s", f"{len(files):,}", ARCHIVE_PREFIX)


def restore_raw(bucket: str | None = None) -> None:
    """Pull `raw/` back down into `data/raw`.

    The first step on a fresh clone or a cold CI runner. The ring cannot seed a
    history it does not hold, so `ingest` refuses to run without this.
    """
    bucket = _bucket(bucket)
    s3 = _client()
    keys = [k for k in _existing(s3, bucket) if k.startswith(ARCHIVE_PREFIX)]
    if not keys:
        raise SystemExit(f"nothing under {ARCHIVE_PREFIX} in {bucket} - has `archive` run?")

    log.info("restoring %s files from %s", f"{len(keys):,}", bucket)

    def one(key: str) -> int:
        dest = config.RAW / key[len(ARCHIVE_PREFIX) :]
        dest.parent.mkdir(parents=True, exist_ok=True)
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        tmp = dest.with_name(dest.name + ".tmp")
        tmp.write_bytes(body)
        tmp.replace(dest)
        return len(body)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        total = sum(pool.map(one, keys))

    log.info("restore complete: %s files, %s MB", f"{len(keys):,}", f"{total / 1e6:.1f}")


def _refuse_a_half_written_export(source: Path, files: list[Path]) -> None:
    """Stop if any shard is newer than the manifest that has to describe it.

    `export_all` writes `meta.json` last, so the manifest being the newest file in
    its own tree is what "the export finished" looks like on disk. An export killed
    part way leaves fresh shards under a manifest from the previous run - and the
    upload would then take that stale manifest as the list of live keys and delete
    every object the new run had not got round to writing yet.

    Cheap, and it fails before anything is sent.
    """
    manifests = [p for p in files if p.name == "meta.json"]
    if not manifests:
        raise SystemExit(
            f"no meta.json under {source} - `znhstry export` has not finished a run here."
        )

    for manifest in manifests:
        tree = manifest.parent
        stamp = manifest.stat().st_mtime_ns
        newer = [
            p for p in files if p.is_relative_to(tree) and p.stat().st_mtime_ns > stamp
        ]
        if newer:
            raise SystemExit(
                f"{len(newer):,} file(s) under {tree} are newer than its meta.json "
                f"(e.g. {newer[0].relative_to(tree)}). The export did not finish, so the "
                f"manifest does not name everything on disk - re-run `znhstry export` "
                f"before uploading."
            )


def upload_all(source: Path | None = None, bucket: str | None = None) -> None:
    source = source or config.WEB_DATA
    bucket = _bucket(bucket)
    if not source.exists():
        raise SystemExit(f"{source} does not exist - run `znhstry export` first.")

    files = sorted(p for p in source.rglob("*") if p.is_file())
    _refuse_a_half_written_export(source, files)

    s3 = _client()
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

    # The manifest always goes, even when identical: it is the cheap file, and
    # a client that finds a stale one finds shards that no longer exist.
    for path in manifests:
        total_bytes += send(path)

    # Orphans from a previous layout, and last of all. Until the new manifest
    # lands, every client is still reading the old one - and the old one names
    # exactly these keys, so deleting them any earlier empties the map for
    # anyone mid-load.
    #
    # The archive prefix is excluded, not merely absent from `key_of`: it lives in
    # this bucket and is not part of the export, so without this line publishing
    # the site would delete the only off-machine copy of the raw layer.
    stale = {k for k in remote if not k.startswith(ARCHIVE_PREFIX)} - set(key_of.values())
    if stale:
        log.info("removing %s orphaned objects", f"{len(stale):,}")
        batch = sorted(stale)
        for i in range(0, len(batch), 1000):
            s3.delete_objects(
                Bucket=bucket,
                Delete={"Objects": [{"Key": k} for k in batch[i : i + 1000]]},
            )

    log.info(
        "upload complete: %s sent, %s skipped, %s MB",
        f"{len(pending) + len(manifests):,}",
        f"{skipped:,}",
        f"{total_bytes / 1e6:.1f}",
    )
