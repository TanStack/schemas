# Monitor residuals

One file per failure that the production monitor
(`.source/agent-workflows/monitor.ts`) must not try to fix: the cause is
upstream and no change in this repository helps. The `check` job reads
every file here and drops a failure that one describes.

A file is named `<provider>-<event>.md` and states the provider, the event
(`ingest_failed`, `pricing_lost` or `update_storm`), the error text to
match, and why no fix is possible. The monitor's `fix` job opens the pull
request that adds one. Delete the file when the upstream cause is gone.
