---
'@modelschemas/client': minor
---

`Model` gains `sameAsRoot`, the row its `sameAs` chain ends at, and `firstParty`, whether the provider is the maker of the model. `ModelFactSources` gains `firstParty` (`FirstPartySource`). `FactSource` gains `derivation: 'name-inferred'` with `key` and `candidates` for a `sameAs` drawn from a matching id, and `variant` for a stated variant id (OpenRouter's `:batch`).
