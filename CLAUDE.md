# wow-guild-loot-prio

<One paragraph: what this service does and who calls it.>

## Stack

- Language / runtime:
- Test command: `npm test`
- Lint command: `npm run lint`
- Entry point:

## Working agreements for agents

- `main` is protected. Every change goes through a PR. Never push to `main`,
  never merge your own PR, never disable a failing test.
- Tests first. A PR whose diff contains no test change needs a sentence in the
  description saying why.
- CI must be green before review: `quality / test` and `quality / security`.
- If acceptance criteria are ambiguous, stop and say so. Do not guess at
  product decisions -- that is what the `Needs you` column is for.

## Agent roles

Defined in `.claude/agents/`:

| Agent | Does | GitHub access |
|---|---|---|
| `product-owner` | Turns wishlist items into tickets with verifiable acceptance criteria | issues RW, code read-only |
| `engineer` | Implements one ticket, TDD-first, opens a PR | code + PRs |
| `reviewer` | Reviews a PR against its acceptance criteria | code + PRs |
| `security-analyst` | Triages CI scanner output, opens remediation issues | issues RW, code read-only |

## Layout

<Point agents at the parts of the tree that matter. This section pays for
itself -- it is the difference between an agent grepping blind and one that
starts in the right file.>
