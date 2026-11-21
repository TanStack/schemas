---
'@modelschemas/client': patch
---

Adds `listProbeObservations` (`GET /v1/admin/probes/{provider}`, admin only, read-only): the Worker's live probe observations with their evidence and whether each is served. The `staleProbes` and schema `probe-verified` descriptions now say probed facts are re-verified by the Worker, not by a committed record.
