# Monitor residuals

Failures that the production monitor (`.source/agent-workflows/monitor.ts`)
must not try to fix: the cause is upstream and no change in this
repository helps. The `pending` job matches them in code. No model reads
these files.

One file per provider and event, `<provider>-<event>.json`, holding a JSON
array:

```json
[
  {
    "providerId": "huggingface",
    "event": "ingest_failed",
    "errorIncludes": "native recommendation section missing",
    "reason": "The source does not publish this section."
  }
]
```

A failure is dropped when its provider and event are equal and its error
contains `errorIncludes` (8 to 300 characters). A file that does not match
this shape fails the job. The monitor's `fix` job opens the pull request
that adds an entry: check that `errorIncludes` is narrow before you merge
it. Delete the entry when the upstream cause is gone.
