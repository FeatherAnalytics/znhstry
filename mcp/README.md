# znhstry-mcp

An MCP server over the Zone History warehouse: fourteen years of zone control in the game QONQR, published nightly as Parquet in a public bucket. It runs DuckDB against those files by URL, so it needs no clone of the data and no credentials.

```
uvx --from "git+https://github.com/FeatherAnalytics/znhstry#subdirectory=mcp" znhstry-mcp
```

Claude Desktop or Claude Code configuration:

```json
{"mcpServers": {"znhstry": {"command": "uvx", "args": ["--from", "git+https://github.com/FeatherAnalytics/znhstry#subdirectory=mcp", "znhstry-mcp"]}}}
```

## Tools

- `list_tables()` — every table with its row count, sort key, and columns; call it first.
- `describe_table(name)` — the same for one table.
- `freshness()` — the newest event date in the published data.
- `query(sql, limit=1000)` — run one read-only DuckDB SQL statement against the tables.

## Read-only by construction

One statement per call, and only SELECT, WITH, DESCRIBE, SHOW, EXPLAIN, or SUMMARIZE; anything else is refused before it reaches DuckDB. Results are capped at 10,000 rows, a query running past 60 seconds is interrupted, and the connection has DuckDB's local filesystem disabled with the configuration locked, so SQL cannot read or write a file on the host.

## Configuration

`ZNHSTRY_DATA_ORIGIN` points the server at a different published export; the default is `https://data.znhstry.com`. The manifest is read from `<origin>/marts/_meta.json` and every table from `<origin>/marts/<table>.parquet`.

`--http HOST:PORT` serves the MCP protocol over streamable HTTP at `/mcp` and exposes `GET /tables` and `GET /query?sql=...&limit=...` as plain JSON on the same port; the default is stdio. Over HTTP the server has no authentication, and a SELECT can still call `read_parquet` on any URL, so a hosted instance fetches whatever URL a caller names; that is for the hosting decision to settle before this flag is exposed to anyone but its operator.
