---
'@modelschemas/client': minor
---

`completeness` on `GET /v1/status` no longer scores origin links: `originLink` (`{ have, need }`) is replaced by `originLinks`, the number of live models with `sameAs` set, which is not part of `score`. See docs/api-changes.md.
