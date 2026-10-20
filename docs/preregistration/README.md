# Preregistrations

Analysis plans are written and hashed before the data they analyze exist. A plan file is never edited after sealing; departures go to its deviations log.

| Test | Plan | Plan hash | Sealed code and data hashes | Deviations |
|---|---|---|---|---|
| P1 Fan-Bar Test | `p1-plan.md` | `p1-plan.sha256` | `p1-code.sha256` | `p1-deviations.md` |

Verify from the repository root:

```bash
(cd docs/preregistration && sha256sum -c p1-plan.sha256)
sha256sum -c docs/preregistration/p1-code.sha256 2>/dev/null | grep -v "data/private"   # public files
```

The `data/private/` entries can only be checked on the machine that holds the private table; their hashes are published so the table cannot change silently. The `.gitattributes` files in the hashed folders keep LF line endings, so the hashes also match a fresh checkout on Windows.
