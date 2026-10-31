# AGENTS.md

<!--
Standing-orders layer: only the rules an agent needs in context in every session.
One to three lines each, each linking its home. No stories, worked examples, or
situational procedures. The test is cost: would an agent that never read this line
make an expensive mistake? Only then does it belong here.
Target length: 30–60 lines. Beyond that, ask which rules have moved house.
-->

<One sentence on what this repository is and its most load-bearing architectural fact. Link the architecture document.>

## Repository layout

```
<Directory tree: only the parts worth a decision, one line of explanation each>
```

## Commands

```sh
<install dependencies>
<run tests>
<run the local gate aggregate>
<build>
```

## Conventions

- **<rule name>**: <One to three lines. State the constraint and its reason, or link the reason.>
- **<rule name>**: <For example: every export carries JSDoc; errors are typed; user-facing copy goes through the localization dictionary.>

## Gates

Run the smallest sufficient evidence before a change; pick the pre-push checks by the surface touched (see project-harness's pre-push guidance).

```sh
node scripts/harness/run-gates.ts doc-quick   # seconds: documents and decision records
node scripts/harness/run-gates.ts check-all   # full run: add build, test, and platform gates to this mode
```

Branch protection requires one aggregate check name. **Never bypass a failing gate** — either change the code, or argue in review that the gate itself is wrong.

## Decision records

Changes that carry durable decision rationale (rejected alternatives, negative guarantees, ownership boundaries, persistence or protocol semantics, security rules) are written into `.agents/notes/{proposed,implemented}/<class>/` in the same change. Mechanical changes and local UI adjustments are exempt.

## Documentation

Document tiers, budgets, and what not to write live in `docs/AGENTS.md`. A repository that keeps an indexed document chain starts from `docs/README.md` (the index) and `docs/00-overview.md` (the ledger): new documents take a slot, are named `<topic>-<type>-<date>.md`, open items enter the ledger, and the ledger is cleared before anything is archived.

## Boundaries

<What this repository deliberately does not do. For example: no external pull requests; no backward-compatibility promise; no executing user code at runtime. This section is often omitted, and it is the one that kills the most circular discussions.>

## Maintaining these instructions

This section declares the repository's working language: **English** — documentation, commit messages, and instruction files share it, and no other file repeats the declaration; changing it is one explicit migration, never a file-by-file drift. **The instruction surface is never paired**: this file, `docs/AGENTS.md`, and the decision corpus's own instruction files each exist once; knowledge that needs two languages (design, usage docs, decision rationale) belongs in `docs/` or `.agents/notes/`, where pairing and its consistency records live.

Rules only, no decisions. Ask of every line: "who has to agree before this changes?" Nobody — a gate run settles it: it is a rule, keep it here. Someone has to be convinced: it is a decision, write it in a decision record and leave a pointer here.

When editing this file: one to three lines per rule, each linked to its home; if `CLAUDE.md` is a symlink to this file, edit the real file; ceilings live in `scripts/harness/doc-budgets.manifest.json` (`node scripts/harness/verify-doc-budgets.ts --list` shows usage) — relocate first, condense second, and raise a ceiling only with the justification in the same change.
