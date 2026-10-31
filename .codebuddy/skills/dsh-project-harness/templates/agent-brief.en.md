# Task brief (agent-brief)

<!--
Purpose: copy this skeleton when a lead dispatches a task to a subagent, then fill it in.
Fill every cell before handing it over; when one is missing, ask first and move only after the answer.
Delete this comment and the placeholders before delivering, so the filled brief reads as instructions.
-->

## Target

- <File / symbol / symptom: which place, what it does; point at `file:line` when one exists.>

## Acceptance

- <The command and the observation that count as done: give a runnable command, never "done".>
- <If one command cannot cover it, list them and say which ones this task requires green.>

## Off-limits

- <What need not be read: the target is located, so do not walk the directory first to build context.>
- <What must not be touched: name the paths outside the write scope; crossing them is a deviation.>

## Deliverable

- <The slot and path where the artifact lands: name the concrete path in the repository's document chain, never "somewhere".>
- <Whether the index and the ledger change in the same batch: name the file when they do, and say why not when they do not.>
- <Never land it at the repository root, in a temp directory, or outside the workspace; only a file in its slot counts as a deliverable.>

## Skill prerequisites

- <Which skill to load before starting: its name, and which references to read right after loading.>
- <A skill's body and references enter the dispatcher's context only; they are never inherited by a subagent.>

## Forbidden

- <Do not edit files outside the write scope; do not git add, commit, or push.>
- <Do not run anything the acceptance section does not name: full test runs, release scripts, commands that change shared state.>

## Report format

- <Which files changed: each path with one line of what changed.>
- <The actual output of the self-check commands: the command, its key lines, and its exit status.>
- <Remaining risks and uncovered surface: which criterion was not checked, and why.>
