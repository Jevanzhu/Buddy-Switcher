# <project> ledger

<!-- Lives at the ledger location the index points to (example: docs/00-overview.md).
     The single list of open items. -->

Record only what is still owed. Finished history lives in its slot document and in git, not here.

| Item | Status | Pointer |
|---|---|---|
| <One-sentence conclusion: what is to be done, or what was settled> | <in progress / awaiting review / blocked: reason> | <document path or commit id> |

## Maintenance

- One line per item: **a one-sentence conclusion plus a pointer.** The conclusion states the decision or the status, not the mood; the pointer is a path or a commit id, never "see the relevant document".
- Add the line when the document is opened (a new design, execution, review, or research document is a new item here); remove it when the item is archived.
- Finished items are deleted, never marked "done" — a ledger that keeps victory laps stops answering "what is still owed" at a glance.
- Clear the ledger before every close-out: no item may sit here finished but attached.
- The status column holds the current stage or the blocking reason, never a percentage.
