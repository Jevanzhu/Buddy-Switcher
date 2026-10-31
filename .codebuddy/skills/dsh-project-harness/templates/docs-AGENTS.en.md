# Documentation

<!-- Lives at docs/AGENTS.md. Defines each tier's scope and its "does not belong here" list. -->

## One fact, one home

Every rule and every fact is defined in exactly one file; everywhere else links to it. Duplicated text forks, and once forked nobody knows which copy to believe.

Before writing a paragraph, ask where the fact already lives. If the answer is somewhere else, rewrite it there and link.

## Tiers

| Tier | Job | Does not belong here |
|---|---|---|
| Root `AGENTS.md` | Standing instructions an agent needs in context every session, one to three lines each | Stories, worked examples, situational procedures |
| `<subtree>/AGENTS.md` | Orders specific to that subtree | Repository-wide rules (link the root) |
| `docs/architecture.md` | How the system assembles, module boundaries, runtime vocabulary | Concrete API signatures (link the source) |
| `docs/subsystems/` | One subsystem's mechanisms and lifecycle | Cross-subsystem orchestration |
| `.agents/notes/` | Why this choice, what was given up | Migration plans, acceptance checklists (once shipped) |
| `docs/cookbook/` | How to do one concrete thing | Why it is designed this way |
| `<package>/README.md` | That package's job, config, public behavior, known limits | Repository architecture |

## Word budgets

```sh
node scripts/harness/verify-doc-budgets.ts
node scripts/harness/verify-doc-budgets.ts --list
```

The ceilings live in `scripts/harness/doc-budgets.manifest.json`. Counting rule: one word per whitespace-delimited token plus one per CJK ideograph — Chinese has no word delimiters, so a token-only count would pass any-length Chinese documents under an English-sized ceiling.

**Over the ceiling, the order is relocate → condense → raise.** Raising one requires the justification in the same change.

A ceiling is a guardrail, not a reduction target: keep at least 5% headroom below it; once above target, freeze the ceiling. **A too-low ceiling is a bug.**

## Format

**One physical line per paragraph.** Code blocks, tables, and lists keep their own format.

Fenced code blocks must pass type checking; a pasted type declaration is marked `ts type-equiv` and registered.

## What not to write

- Duplicated rules (the same rule in two places)
- History outside its tier ("it used to be A, then B" → decision record)
- Implementation-status annotations ("shipped!", "future work…")
- Hand-copied inventories (constants, test lists, function signatures)
- Reasoning transcripts ("first I looked at A, then at B")
- Rationale repeated beside sibling methods
- Paragraph walls
- Emphasis inflation (bold everywhere means nothing stands out)
