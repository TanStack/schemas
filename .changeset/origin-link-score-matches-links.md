---
'@modelschemas/client': patch
---

`completeness.originLink.need` on `GET /v1/status` counts only models the link rules linked (`sameAs` set), not every model whose id another provider also lists. The type is unchanged; its description says so. See docs/api-changes.md.
