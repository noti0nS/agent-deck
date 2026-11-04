# Privacy and stored data

Agent Deck reads the locally installed agents' session evidence: project names
and paths, titles, message previews, tool activity, file changes, errors and token
usage. Treat the dashboard and database as private development data.

## First start and network traffic

On the first start, Agent Deck backfills up to 90 days of available history into
its own SQLite database. Set `AGENT_DECK_IMPORT_HISTORY=0` before starting to skip
that bulk import. Adapters still observe current/recent source records; this flag
does not make the dashboard metadata-free. `agent-deck import` explicitly imports
history later.

The collector refreshes the public models.dev pricing catalog at most once per
day. That request downloads the catalog; it does not upload agent sessions. Agent
adapters connect to configured local agent services. An `OPENCODE_SERVER_URL` you
override is a destination you choose. Dashboard clients receive session data from
your collector. There is no application analytics or central session upload.

## Storage and redaction limits

The default database is `~/.agent-deck/collector.db` (the user's home on each OS).
`AGENT_DECK_DB_PATH` overrides it. SQLite WAL/SHM sidecar files may exist while it
is running. It is not encrypted by Agent Deck; protect your OS account and disk.
Device token hashes, pairing codes, preferences, adapter cursors and the cached
model catalog also live there. Only share sanitized diagnostic excerpts.

The redactor removes recognized token patterns and sensitive credential paths,
and protects recognized `.env` content. It cannot reliably detect every secret,
personal detail or private prompt. Redaction is not anonymization and should not
be used as permission to publish a real session or database.

The store has cleanup support for events older than 14 days, steps older than
30 days and usage downsampling after 24 hours. Runs, message previews and usage
aggregates have no automatic expiry. There is no claim that all personal data is
deleted after 90 days; 90 days is the history import window.

The service worker caches static application assets, not `/api/` responses. A
browser may still hold currently displayed session data in memory. Close the tab
after logout and clear site data on a shared device.

## Delete data

1. Stop all collector processes using the database.
2. Delete `collector.db` and its matching `collector.db-wal` / `collector.db-shm`
   sidecars from the configured location. Remove backup copies separately.
3. Clear Agent Deck site data in each browser if you want to remove cookies and
   cached application assets.

This removes Agent Deck's records and pairings, not the agents' original history.
Starting again can reimport that original history. Set `AGENT_DECK_IMPORT_HISTORY=0`
to skip bulk backfill; ongoing adapter observation still reads available evidence.
Uninstalling hook entries does not delete agent configuration backups.
