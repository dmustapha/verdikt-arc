# Parameterized query — the username is bound as a parameter, never inlined.
def build_user_query(username: str):
    sql = "SELECT * FROM users WHERE name = %s"
    params = (username,)
    return sql, params
