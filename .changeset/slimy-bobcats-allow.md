---
"@tim-smart/openapi-gen": patch
---

Removed implicit non-null assertion on `config.transformClient` that triggers
linters, added `override` keyword into custom error implementation to follow
strict ts configs with `"noImplicitOverride": true,` compiler option
