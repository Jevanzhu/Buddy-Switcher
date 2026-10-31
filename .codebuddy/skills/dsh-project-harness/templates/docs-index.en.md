# <project> documentation index

<!-- Lives at the index document's location (example: docs/README.md). Whole-chain navigation:
     one row per slot directory, and every top-level document is referenced here exactly once. -->

## Slots

| Directory | Job | Documents |
|---|---|---|
| `00-overview.md` | Ledger: open items | — |
| `01-review` | Review verdicts and acceptance decisions | 0 |
| `02-execution` | Batch plans and delivery records | 0 |
| `03-design` | Designs and trade-offs | 0 |
| `04-research` | Research reports and feasibility findings | 0 |
| `05-standards` | Long-lived operating standards | 0 |
| `Archive/` | Frozen history, read-only | — |

## Validation

`scripts/harness/verify-doc-index.ts` compares this table with the disk, under four rules: every declared directory must exist; every top-level directory under `docs/` must be declared; every document at this directory's top level must appear in the table once; and where a count is declared, the number on that row must equal the documents actually on disk.

The count is a **declaration**, not a display: bump it when a document lands, and the gate turns red when the two disagree. Counting skips dotfiles — `.gitkeep` is not a document, and an empty directory may still hold its place.

Slot names may change (`03-design` → `design` is fine); when they do, update `scripts/harness/doc-index.manifest.json` and this table together — the contract is material, declaration, and disk agreeing, not any particular name.
