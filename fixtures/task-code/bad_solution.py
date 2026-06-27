# Vulnerable: untrusted input is string-formatted directly into the SQL (injection).
def build_user_query(username: str):
    sql = "SELECT * FROM users WHERE name = '%s'" % username  # B608: SQL built via string formatting
    params = ()
    return sql, params
