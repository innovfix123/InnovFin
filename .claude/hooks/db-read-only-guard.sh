#!/usr/bin/env bash
# PreToolUse(Bash) guard — PERMANENT read-only database enforcement.
#
# Denies any Bash command that would WRITE to a database:
#   - mysqlimport (a pure data-load / write tool) is always blocked.
#   - mysql / mariadb / mysqladmin commands containing a write/DDL/DCL keyword
#     (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, REPLACE, RENAME,
#      GRANT, REVOKE, MERGE, SET PASSWORD, LOAD DATA, INTO OUTFILE/DUMPFILE) are blocked.
# Read-only statements (SELECT / SHOW / DESCRIBE / EXPLAIN) pass through.
# Word-boundary matching keeps identifiers like `updated_at` / `created_at` and
# values like 'deleted' from tripping the filter.
#
# Backs the standing rule "never write to any DB, read-only forever"
# (auto-memory: db-read-only-forever). The real backstop is the read-only DB
# user (e.g. analytics_ro); this hook is defense-in-depth on the Bash path.

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}' \
    "$(jq -Rn --arg m "$1" '$m')"
  exit 0
}

cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

# mysqlimport writes/loads data — never permitted.
if printf '%s' "$cmd" | grep -iqE '\bmysqlimport\b'; then
  deny "Blocked: mysqlimport writes data into the database, which is read-only. Permanent rule (db-read-only-forever)."
fi

# For interactive DB clients, block any write / DDL / DCL statement.
if printf '%s' "$cmd" | grep -iqE '\b(mysql|mariadb|mysqladmin)\b'; then
  if printf '%s' "$cmd" | grep -iqE '\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|RENAME|GRANT|REVOKE|MERGE|SET[[:space:]]+PASSWORD|LOAD[[:space:]]+DATA|INTO[[:space:]]+(OUT|DUMP)FILE)\b'; then
    deny "Blocked: the database is READ-ONLY. Writes (INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/GRANT/REVOKE/…) are never permitted — permanent rule (db-read-only-forever). Use SELECT / SHOW / DESCRIBE / EXPLAIN only."
  fi
fi

exit 0
