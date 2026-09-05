import duckdb
import pytest

from znhstry_mcp.server import check_statement, lock_down


def test_rejects_writes_multiples_and_pragmas():
    with pytest.raises(ValueError, match="read-only"):
        check_statement("delete from dim_zone")
    with pytest.raises(ValueError, match="one statement"):
        check_statement("select 1; select 2")
    with pytest.raises(ValueError):
        check_statement("pragma version")
    with pytest.raises(ValueError):
        check_statement("/* looks harmless */ pragma version")


def test_accepts_read_only_forms():
    assert check_statement("with a as (select 1 as x) select x from a;") == (
        "with a as (select 1 as x) select x from a"
    )
    assert check_statement("describe select 1") == "describe select 1"
    assert check_statement("explain select 1") == "explain select 1"


def test_lock_down_disables_local_filesystem():
    con = duckdb.connect()
    lock_down(con)
    with pytest.raises(duckdb.PermissionException):
        con.execute("select * from read_csv('/etc/hosts')").fetchall()
    assert con.execute("select 1").fetchall() == [(1,)]
