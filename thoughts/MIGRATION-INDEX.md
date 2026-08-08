# Migration index

Transitional code only. Every row is scheduled for deletion. Delete this file last.

| # | Location | Symbol | Delete when |
|---|---|---|---|
| 1 | `pipeline/src/znhstry/ingest.py` | `migrate()` | after it has run against prod data |
| 2 | `pipeline/src/znhstry/ingest.py` | `repartition()` | with #1 |
| 3 | `pipeline/src/znhstry/ingest.py` | `consolidate_zones()` | with #1 |
| 4 | `pipeline/src/znhstry/__main__.py` | `STEPS["migrate"]` | with #1 |
| 5 | `pipeline/src/znhstry/extract.py` | whole module | after Phase 8 reconciliation passes |
| 6 | `pipeline/src/znhstry/api.py` | whole module | with #5 |
| 7 | `pipeline/src/znhstry/__main__.py` | `STEPS` keys `all`, `lookups`, `zones`, `changelog`, `baseline`, `update` | with #5 |
| 8 | `pipeline/src/znhstry/config.py` | `API_BASE`, `MAX_WORKERS`, `MIN_REQUEST_INTERVAL`, `REQUEST_TIMEOUT`, `MAX_RETRIES`, `BACKOFF_BASE`, `MAX_SQL_BYTES` | with #5 |
| 9 | `pipeline/src/znhstry/config.py` | `HISTORY_START`, `MONTHLY_FROM_YEAR`, `ZONE_ID_CHUNK`, `ZONE_ID_HEADROOM` | with #5 |
| 10 | `.github/workflows/archive-raw-data.yml` | whole file | Phase 5 |
| 11 | `pipeline/src/znhstry/ingest.py` | `seed_battlestats()` | when the portal scraper lands; keep until then |
| 12 | `thoughts/ledgers/CONTINUITY_CLAUDE-dropbox-ingest.md` | whole file | on merge |
| 13 | `thoughts/MIGRATION-INDEX.md` | this file | last |
