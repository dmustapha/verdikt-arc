# Payer's acceptance test. The worker delivers solution.py; the payer ships this test.
# A worker cannot fake a pass by shipping its own green tests — these are the payer's.
# build_user_query returns (sql_template, params): the username MUST be a bound param,
# never inlined into the SQL string.
from solution import build_user_query

def test_returns_template_and_params():
    sql, params = build_user_query("alice")
    assert isinstance(sql, str) and "users" in sql.lower()
    # The username must be carried as a bound parameter, not inlined into the SQL.
    assert "alice" in params, "username was not passed as a bound parameter"

def test_is_parameterized_not_concatenated():
    # Malicious input must NOT appear inside the SQL string (that would be injection).
    sql, params = build_user_query("alice'; DROP TABLE users;--")
    assert "DROP TABLE" not in sql, "raw input was concatenated into SQL (injection)"
