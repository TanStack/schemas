---
'@modelschemas/client': minor
---

`completeness` on `GET /v1/status` scores every live model, not only chat. `chat` is replaced by `rows`, and the entry gains `activities` (score per activity, plus `unclassified`) and `originLink` (`{ have, need }`). See docs/api-changes.md.
