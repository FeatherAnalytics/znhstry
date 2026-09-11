"""MCP server over the published Zone History marts: DuckDB reading Parquet by URL."""

from __future__ import annotations

import argparse
import datetime as dt
import decimal
import functools
import json
import logging
import os
import re
import threading
import time
from typing import Any

import duckdb
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse

ORIGIN = os.environ.get("ZNHSTRY_DATA_ORIGIN", "https://data.znhstry.com").rstrip("/")
MANIFEST_URL = f"{ORIGIN}/marts/_meta.json"
MAX_ROWS = 10_000
QUERY_TIMEOUT_S = 60.0
READ_ONLY_TYPES = {"SELECT", "EXPLAIN"}
# PRAGMA parses as SELECT, and CALL is how a pragma is spelled as a function.
REJECTED_FIRST_WORDS = {"pragma", "call"}

log = logging.getLogger("znhstry_mcp")

mcp = MCPServer(
    "znhstry",
    instructions=(
        "Zone History: fourteen years of zone control in the game QONQR, published nightly as "
        "Parquet and read here with DuckDB SQL. Only read-only SQL is accepted, one statement "
        "per call, capped at 10,000 rows. Call list_tables first to see the tables and columns."
    ),
)

_con: duckdb.DuckDBPyConnection | None = None
_manifest: dict[str, Any] | None = None
_setup_lock = threading.Lock()
_query_lock = threading.Lock()


def lock_down(con: duckdb.DuckDBPyConnection) -> None:
    """Keep httpfs, drop the local filesystem, and lock the configuration so SQL cannot undo it."""
    try:
        con.execute("install httpfs")
    except duckdb.Error as exc:  # already installed, or offline with it cached
        log.debug("install httpfs: %s", exc)
    con.execute("load httpfs")
    # httpfs opens ~/.duckdb/stored_secrets on its first request; with the local filesystem
    # disabled that fails and leaves every later HTTP read broken.
    con.execute("set allow_persistent_secrets = false")
    con.execute("set disabled_filesystems = 'LocalFileSystem'")
    con.execute("set lock_configuration = true")


def _connect() -> tuple[duckdb.DuckDBPyConnection, dict[str, Any]]:
    """The one connection and the manifest, created on first use so importing touches no network."""
    global _con, _manifest
    with _setup_lock:
        if _con is not None and _manifest is not None:
            return _con, _manifest
        con = duckdb.connect()
        lock_down(con)
        try:
            newest, tables_json = con.execute(
                "select newest_event_date, to_json(tables) from read_json_auto(?)", [MANIFEST_URL]
            ).fetchone()
        except duckdb.Error as exc:
            raise ValueError(f"cannot read the manifest at {MANIFEST_URL}: {exc}") from exc
        tables = json.loads(tables_json)
        for name, table in tables.items():
            url = f"{ORIGIN}/marts/{table['path']}".replace("'", "''")
            view_sql = f"""create or replace view "{name}" as select * from read_parquet('{url}')"""
            con.execute(view_sql)
        _manifest = {"newest_event_date": str(newest), "tables": tables}
        _con = con
        return con, _manifest


def check_statement(sql: str) -> str:
    """Return the single read-only statement in `sql`, or raise ValueError saying why not."""
    statements = duckdb.extract_statements(sql)
    if not statements:
        raise ValueError("empty statement")
    if len(statements) != 1:
        raise ValueError(f"one statement at a time; got {len(statements)}")
    kind = statements[0].type.name
    if kind not in READ_ONLY_TYPES:
        raise ValueError(
            "only read-only statements are allowed "
            f"(SELECT, WITH, DESCRIBE, SHOW, EXPLAIN, SUMMARIZE); got {kind}"
        )
    text = sql.strip().rstrip(";").strip()
    if _first_word(text) in REJECTED_FIRST_WORDS:
        raise ValueError(
            "only read-only statements are allowed "
            f"(SELECT, WITH, DESCRIBE, SHOW, EXPLAIN, SUMMARIZE); got {_first_word(text).upper()}"
        )
    return text


def _first_word(text: str) -> str:
    # Both comment forms, or `/* */ pragma ...` reads as a statement starting with "/*".
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    code = [line for line in text.splitlines() if not line.lstrip().startswith("--")]
    words = "\n".join(code).split()
    return words[0].lower() if words else ""


def _cell(value: Any) -> Any:
    if value is None or isinstance(value, bool | int | float | str):
        return value
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, dt.date | dt.datetime):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    return str(value)


def run_query(sql: str, limit: int = 1000) -> dict[str, Any]:
    """Run one read-only statement and return columns, rows, and whether the cap cut it short."""
    stmt = check_statement(sql)
    limit = max(1, min(int(limit), MAX_ROWS))
    is_explain = _first_word(stmt) == "explain"
    to_run = stmt if is_explain else f"select * from ({stmt}) as q limit {limit + 1}"
    con, _ = _connect()
    started = time.monotonic()
    with _query_lock:
        timer = threading.Timer(QUERY_TIMEOUT_S, con.interrupt)
        timer.start()
        try:
            cursor = con.execute(to_run)
            rows = cursor.fetchall()
            description = cursor.description or []
        except duckdb.InterruptException as exc:
            raise ValueError(f"query exceeded {QUERY_TIMEOUT_S:.0f} s and was interrupted") from exc
        except duckdb.Error as exc:
            raise ValueError(str(exc)) from exc
        finally:
            timer.cancel()
    truncated = not is_explain and len(rows) > limit
    rows = rows[:limit]
    return {
        "columns": [{"name": d[0], "type": str(d[1])} for d in description],
        "rows": [[_cell(v) for v in row] for row in rows],
        "row_count": len(rows),
        "truncated": truncated,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


def _table_entry(name: str, table: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": name,
        "rows": table["rows"],
        "sort": table["sort"],
        "columns": table["columns"],
    }


def _as_tool_error(fn):
    """Only a ToolError reaches the client with its message; anything else is logged as a crash."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except ValueError as exc:
            raise ToolError(str(exc)) from exc

    return wrapper


@mcp.tool()
@_as_tool_error
def list_tables() -> dict[str, Any]:
    """List every table with its row count, sort key, and columns; call this first."""
    _, manifest = _connect()
    return {
        "newest_event_date": manifest["newest_event_date"],
        "tables": [_table_entry(n, t) for n, t in manifest["tables"].items()],
    }


@mcp.tool()
@_as_tool_error
def describe_table(name: str) -> dict[str, Any]:
    """Row count, sort key, and columns for one table."""
    _, manifest = _connect()
    if name not in manifest["tables"]:
        raise ValueError(f"unknown table {name!r}; see list_tables")
    return _table_entry(name, manifest["tables"][name])


@mcp.tool()
@_as_tool_error
def freshness() -> dict[str, Any]:
    """The newest event date in the published data (re-reads the manifest each call)."""
    con, _ = _connect()
    try:
        (newest,) = con.execute(
            "select newest_event_date from read_json_auto(?)", [MANIFEST_URL]
        ).fetchone()
    except duckdb.Error as exc:
        raise ValueError(f"cannot read freshness from {MANIFEST_URL}: {exc}") from exc
    return {"newest_event_date": str(newest)}


@mcp.tool()
@_as_tool_error
def query(sql: str, limit: int = 1000) -> dict[str, Any]:
    """Run one read-only DuckDB SQL statement against the tables; at most 10,000 rows."""
    return run_query(sql, limit)


_CORS = {"Access-Control-Allow-Origin": "*"}


@mcp.custom_route("/tables", methods=["GET"])
async def tables_route(request: Request) -> JSONResponse:
    try:
        return JSONResponse(await run_in_threadpool(list_tables), headers=_CORS)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500, headers=_CORS)


@mcp.custom_route("/query", methods=["GET"])
async def query_route(request: Request) -> JSONResponse:
    sql = request.query_params.get("sql", "")
    limit = request.query_params.get("limit", "1000")
    try:
        result = await run_in_threadpool(run_query, sql, int(limit))
        return JSONResponse(result, headers=_CORS)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400, headers=_CORS)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500, headers=_CORS)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="znhstry-mcp", description="Query the Zone History marts."
    )
    parser.add_argument(
        "--http",
        metavar="HOST:PORT",
        help=(
            "serve over streamable HTTP at /mcp and expose GET /tables and GET /query?sql= "
            "as plain JSON on the same port; default is stdio"
        ),
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if args.http:
        host, _, port = args.http.rpartition(":")
        mcp.run(transport="streamable-http", host=host or "127.0.0.1", port=int(port))
    else:
        mcp.run()


if __name__ == "__main__":
    main()
