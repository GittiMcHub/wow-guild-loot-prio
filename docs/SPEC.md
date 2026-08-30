# Guild Loot Priority System (GLPS) — Implementation Specification

**Audience:** Claude Code / autonomous software engineering agents
**Status:** v1.0 — ready for implementation
**Working title:** `glps` (Guild Loot Priority System)

---

## 0. How to use this document

This spec is written to be executed top-to-bottom by coding agents.

* **Section 2 (Domain Rules) is normative and must not be reinterpreted.** If the code disagrees with Section 2, the code is wrong.
* **Section 3 (Resolver)** must be implemented as a pure, side-effect-free function with 100% branch coverage before any UI work starts.
* Anything in **Section 15 (Open Decisions)** is *not* to be invented by the agent. Implement the stated default, put the alternative behind a config flag, and surface the question in the PR description.
* Do not add features not listed here. Scope creep (attendance points, DKP, EPGP, loot council voting, Discord bots) is explicitly out of scope for v1.

---

## 1. Problem statement & goals

A World of Warcraft guild's loot master needs to collect, before a raid phase starts, a **ranked wishlist** from every raider and then, when an item drops, get an instant, deterministic, auditable answer to: *"Who gets this item?"*

### Goals

1. Loot master creates a **Phase** (e.g. "Phase 3 — Temple of Ahn'Qiraj") and sends **invites** to raiders.
2. Raiders fill in **two priority lists** (Main list and Off list), each of up to 17 items ranked 1..17, one item per equipment slot.
3. Once submitted, a list is **immutable** (admin can unlock with an audit trail).
4. Loot master gets an **admin console**: slot × priority × player matrix, per-item claim lists, and a one-click "who wins this drop" resolver.
5. Every player has a **personal access token / link** to view their own submitted list at any time.
6. **Export** the whole phase into a format a WoW addon can consume in-game; **import** loot history / attendance back from the addon.
7. One deployment serves **many independent guilds**. A guild's data, tokens, admins, and loot rules are invisible and inaccessible to every other guild (§3A).

### Non-goals (v1)

* DKP, EPGP, suicide-kings, attendance-weighted systems.
* In-game addon *implementation* (we only define the data contract; the addon is a separate project).
* Cross-guild features: shared rosters, global standings, guild-to-guild transfers, public leaderboards. Guilds are hard-isolated islands (§3A).
* Self-service guild signup / billing. Guilds are provisioned by the instance operator via CLI or the instance-admin screen.
* Live Blizzard API auth ("Battle.net login"). Item metadata sync is optional and offline-first.

---

## 2. Domain rules (NORMATIVE)

### 2.1 Entities

| Term | Meaning |
|---|---|
| **Player** | A human. Owns 1..2 characters within a phase. |
| **Character** | A WoW character: name, class, main spec, off spec, `is_main_character` flag. |
| **Reserved characters** | The 1 or 2 characters a player commits to the raid for this phase. |
| **Slot** | One of 17 equipment slots (see 2.2). |
| **Entry** | `(list, rank, character, spec, slot, item_id)` — one wishlist line. |
| **List** | `MAIN` or `OFF`. Each holds up to `effectiveCapacity` entries (default 17, reduced by two-handers) with unique ranks 1..N. |
| **Claim** | A live contest for a dropped item, derived from an Entry. |

### 2.2 The 17 slots

The number 17 in "priority 1..17" comes directly from the 17 rankable gear slots:

```
HEAD, NECK, SHOULDER, BACK, CHEST, WRIST, HANDS, WAIST, LEGS, FEET,
FINGER_1, FINGER_2, TRINKET_1, TRINKET_2, MAIN_HAND, OFF_HAND, RANGED
```

Shirt and Tabard are excluded. `RANGED` covers bow/gun/crossbow/wand/relic (idol, libram, totem).
Rings and trinkets are two independent slots each, so a player may wish for two different rings.

**Two-handed weapons (`twohand_consumes_offhand`, guild setting, default `true`):**

A two-handed weapon physically occupies both hands, so when this setting is on it consumes **both** `MAIN_HAND` and `OFF_HAND` for that character within that list. Consequences:

* If a character's entry in `MAIN_HAND` is an item with `inventory_type = TWOHAND`, that character **may not** also have an `OFF_HAND` entry in the same list. Attempting it is a blocking validation error, not a warning.
* The list's **effective capacity shrinks by one per two-handed entry**. A single character with a 2H can rank 16 items, not 17.
* With two reserved characters, the reduction is per character: if both list a 2H in the same list, capacity is 15.

```
effectiveCapacity(list) = list_size - count(characters holding a TWOHAND MAIN_HAND entry in that list)
```

* **The restriction is scoped to a single list.** A warrior may list a 2H in the MAIN list (Fury main spec) *and* a shield in the OFF_HAND of the OFF list (Protection off spec) — different specs, different lists, no conflict. Only within one list does a 2H block the off hand.
* Ranks remain contiguous `1..N` where `N <= effectiveCapacity(list)`.
* Setting `twohand_consumes_offhand = false` reverts to the old behaviour: full `list_size` capacity and a non-blocking warning instead of an error. Guilds whose raiders swap between a 2H set and a dual-wield set may prefer this.

### 2.3 The two lists

Each player gets exactly two lists per phase:

* **MAIN list** — up to `effectiveCapacity(MAIN)` entries, ranks 1..N unique.
* **OFF list** — up to `effectiveCapacity(OFF)` entries, ranks 1..N unique.

Capacity is `list_size` (default 17) minus one per two-handed weapon in that list, per §2.2. The two lists are sized independently: a 2H in the MAIN list does not shrink the OFF list.

Ranks are **contiguous starting at 1** within each list (no gaps). A player may submit fewer entries than the capacity allows.

#### Which character/spec may appear in which list

Whether a character is the player's main or their second/alt character is **irrelevant to loot resolution**. It is only a validation input that decides which list an entry is allowed to land in, plus a display attribute. Once the entry is in a list, the list tier is the whole story: resolution compares `(list, rank)` and nothing else.

> **MAIN beats OFF, always.** A MAIN-list claim at rank 17 defeats an OFF-list claim at rank 1, regardless of which character or spec either claim belongs to.

**MAIN list — allowed sources:**

* Reserved character #1, **main spec**.
* Reserved character #2, **main spec** (only if the player reserved two characters).

**OFF list — allowed sources:**

* Reserved character #1, **off spec**.
* Reserved character #2, **main spec** — *if and only if* character #2's main spec is not already the source of MAIN entries… no: it **may** be used in both lists. See rule below.
* Reserved character #2, **off spec** — allowed only when `ALLOW_ALT_OFFSPEC_IN_OFF_LIST=true` (default: **true**, it costs nothing and cannot outrank anything).

**Mixing rule (explicitly requested):** a player with two reserved characters may split their 17 MAIN ranks across both characters' main specs in any proportion (e.g. 10 entries on Char A main spec + 7 entries on Char B main spec). Slots not covered by the MAIN list are then typically covered by the OFF list, but the system does not require this.

**Uniqueness constraints per list:**

* `rank` is unique within `(submission, list)`.
* `(character_id, slot)` is unique within `(submission, list)` — a character cannot have two wishes for the same slot in the same list.
* The same `slot` **may** appear twice in a list if it belongs to two different characters (e.g. Char A's NECK at rank 3 and Char B's NECK at rank 9). This is a direct consequence of the split-main rule.
* The same `item_id` may appear in both MAIN and OFF (e.g. a neck that is BiS for both specs). It may **not** appear twice within the same list for the same character.

### 2.4 Award resolution rules

When item `X` drops:

1. Collect all **unfulfilled** entries with `item_id = X`, in the current phase, whose character is marked **present** for this raid (see 2.6).
2. **Collapse to one claim per player**: if one player has multiple entries for `X` (e.g. on both characters, or on both lists), keep only their strongest entry by the ordering below. A player never rolls twice against themselves.
3. Sort claims by this ordered comparison key — **these two components are the complete ruleset**:

   1. **List tier** — `MAIN` (0) before `OFF` (1). A MAIN claim of rank 17 beats an OFF claim of rank 1.
   2. **Rank** — ascending (1 is strongest).
   3. → If two or more claims are still equal on *both*, they go to a **dice roll**; highest roll wins.

   Main-character vs. alt-character is **not** a comparison component and must not be used as a tiebreak.

4. The winner is the top claim. If the top group has >1 claim, the loot master resolves the roll (see 2.5) and the system records the result.

**Worked example (from the requirements — this must exist verbatim as a test case):**

```
Player A, Char A (main spec):  Item1 @ MAIN rank 1,  Item2 @ MAIN rank 2
Player B, Char B (main spec):  Item3 @ MAIN rank 1,  Item2 @ MAIN rank 2

Item1 drops -> A wins outright (sole MAIN claim).
Item2 drops -> A and B tie (MAIN, rank 2 both) -> dice roll.
Item3 drops -> B wins outright.

If Player C has Item1 @ OFF rank 1, C only wins Item1 when no MAIN claim exists for it.
```

**Worked example 2 — cross-tier (also a mandatory test case):**

```
Char A: ItemX @ MAIN rank 5
Char B: ItemX @ OFF  rank 1

ItemX drops -> Char A wins outright. No roll.
Reason: MAIN outranks OFF before rank is ever compared.
This holds even if Char A is an alt character and Char B is a main character.
```

### 2.4.1 Equal-distribution tiebreak ("BiS Count")

Configurable. When enabled, it inserts **one additional comparison step that applies only inside an otherwise-exact tie** (same list tier *and* same rank). It can never promote an OFF claim over a MAIN claim, and never promote a rank-3 over a rank-2.

**Rule:** among tied claims, the claim(s) belonging to the player(s) with the **lowest BiS Count** win the step. Everyone above that minimum is dropped from the winner group. If two or more remain at the minimum, they roll as usual.

```
Item Y drops. All three claims are MAIN rank 2.
  Player A — BiS Count 2
  Player B — BiS Count 1
  Player C — BiS Count 1

minimum = 1  ->  winner group = { B, C }  ->  B and C roll. A does not roll.
If C had BiS Count 0, C would win outright with no roll at all.
```

**BiS Count definition** — the weighted number of items a player has already been awarded, counted over a configurable window:

| Config | Values | Default | Meaning |
|---|---|---|---|
| `EQUAL_DISTRIBUTION_MODE` | `OFF` \| `PHASE` \| `SESSION` | `PHASE` | `OFF` disables the step entirely. `PHASE` counts every award since the phase started. `SESSION` counts only the current raid session. |
| `BIS_COUNT_SCOPE` | `PLAYER` \| `CHARACTER` | `PLAYER` | `PLAYER` sums awards across both reserved characters — loot to your alt still counts as your loot. `CHARACTER` counts per character. |
| `BIS_COUNT_WEIGHT_MAIN` | number | `1` | Weight of an award that fulfilled a MAIN-list entry. |
| `BIS_COUNT_WEIGHT_OFF` | number | `0` | Weight of an award that fulfilled an OFF-list entry. Default `0`: offspec loot is "free" and does not penalise a player in later main-priority ties. Set to `1` to make all loot count equally. |
| `BIS_COUNT_WEIGHT_OVERRIDE` | number | `1` | Weight of an admin/imported `OVERRIDE` award that fulfilled an entry. |

Awards **never** counted, regardless of config: `FREE_ROLL`, `DISENCHANT`, `BANK`, and any award with `reverted_at IS NOT NULL`. These fulfill no entry and must not penalise a player.

Counts are computed once per resolve call and passed into the resolver — the resolver stays pure. Every resolved claim carries its `bisCount` and, when it was dropped by this step, a machine-readable reason so the UI can say *"A sits out: 2 items vs 1"*.



### 2.5 Dice rolls

* The loot master triggers a roll from the resolver UI. The server generates one integer per tied claim in `[1..100]` using a CSPRNG, persists them with a timestamp, and declares the highest. Re-rolls on an exact tie are automatic and also persisted.
* Alternatively, the loot master may enter **in-game `/roll` results manually** (radio toggle in the UI, `source = INGAME`). Both paths write to the same `rolls` table.
* Rolls are immutable once written. A voided roll is a new row with `voided_by_admin_id` set on the old one.

### 2.6 Attendance / eligibility

A claim only counts if its character is in the raid. The resolver takes an explicit `present_character_ids[]` parameter.

* Default: the loot master maintains a "tonight's roster" toggle list in the admin console (persisted per `raid_session`).
* If no roster is set, **all submitted characters are considered present** and the resolver returns a `warning: NO_ROSTER_SET`.
* Attendance can also be bulk-imported from the addon (Section 9.3).

### 2.7 Fulfillment

* When an award is recorded, the winning **entry** is marked `fulfilled_at`. That entry no longer produces claims.
* Other entries of the same player (different items) are unaffected. Receiving your rank-1 item does **not** demote your remaining priorities in v1 (see Open Decision D-2).
* An award can be **reverted** by an admin (audited); reverting clears `fulfilled_at`.
* An item awarded as "disenchanted / offspec free-for-all" is recorded with `award_type = DISENCHANT | FREE_ROLL` and does not fulfill any entry.

---

## 3. The Resolver (build this first)

Implement as a **pure function** in `packages/core` with zero I/O. Everything else in the system is plumbing around it.

```ts
type ListTier = 'MAIN' | 'OFF';

interface ClaimInput {
  entryId: string;
  playerId: string;
  characterId: string;
  characterName: string;
  isMainCharacter: boolean;   // DISPLAY ONLY — must never affect ordering
  spec: string;
  list: ListTier;
  rank: number;               // 1..17
  slot: Slot;
  itemId: number;
}

interface ResolveOptions {
  equalDistributionMode: 'OFF' | 'PHASE' | 'SESSION';   // default 'PHASE'
  bisCountScope: 'PLAYER' | 'CHARACTER';                // default 'PLAYER'
  /** Pre-computed by the caller. Keyed by playerId or characterId per bisCountScope.
   *  Missing key = 0. Weights are already applied by the caller. */
  bisCounts: Record<string, number>;
}

interface ResolvedClaim extends ClaimInput {
  bisCount: number;
  excludedReason?: 'OUTRANKED' | 'HIGHER_BIS_COUNT' | 'NOT_PRESENT' | 'FULFILLED' | 'WEAKER_CLAIM_SAME_PLAYER';
}

interface ResolveResult {
  ranked: ResolvedClaim[];      // full ordering, best first
  winnerGroup: ResolvedClaim[]; // size 1 = outright, size >1 = roll required
  needsRoll: boolean;
  warnings: string[];
}

function resolveDrop(
  itemId: number,
  candidates: ClaimInput[],
  presentCharacterIds: Set<string>,
  options: ResolveOptions
): ResolveResult;
```

**Algorithm:**

```
1. filter: claim.itemId === itemId
2. filter: presentCharacterIds.has(claim.characterId)
3. filter: !claim.fulfilled
4. group by playerId -> keep min(comparisonKey) per player
5. sort by comparisonKey
6. winnerGroup = all claims whose comparisonKey equals the best key
7. needsRoll = winnerGroup.length > 1
```

**Comparison key (lexicographic, all ascending):**

```
[ tierWeight(list),          // MAIN=0, OFF=1
  rank,                      // 1..17
  bisCount                   // 0 for every claim when equalDistributionMode === 'OFF'
]
```

Because the key is lexicographic, `bisCount` only ever separates claims that are already equal on both tier and rank — exactly the intended behaviour. When `equalDistributionMode` is `OFF`, the resolver substitutes `0` for every `bisCount`, the key collapses to `[tier, rank]`, and the step is a no-op.

`isMainCharacter`, `spec`, and `characterId` must never enter the key — a lint-level rule and a dedicated test enforce this.

**Required test matrix** (table-driven, `resolver.spec.ts`):

| # | Scenario | Expected |
|---|---|---|
| 1 | Single MAIN claim | outright winner, no roll |
| 2 | MAIN r1 vs MAIN r2 | r1 wins, no roll |
| 3 | MAIN r2 vs MAIN r2 | roll between both |
| 4 | MAIN r17 vs OFF r1 | MAIN wins, no roll |
| 5 | OFF r1 vs OFF r1 | roll |
| 6 | No claims at all | empty result, `warning: NO_CLAIMS` |
| 7 | Same player, MAIN r5 on Char A + OFF r1 on Char B | one claim only (MAIN r5) |
| 8 | Same player has MAIN r3 and MAIN r9 for same item on two chars | one claim only (r3) |
| 9 | Claimant not in `presentCharacterIds` | excluded |
| 10 | Winning entry already `fulfilled` | excluded; next claim promoted |
| 11 | The full worked example from §2.4 | matches expected output exactly |
| 12 | 3-way tie | winnerGroup size 3 |
| 13 | MAIN r5 (alt character) vs OFF r1 (main character) | MAIN r5 wins outright, no roll |
| 14 | Same tier + same rank, one claim on a main char and one on an alt | **roll** — main/alt must not break the tie |
| 15 | Property test: shuffling `isMainCharacter` / `spec` / `characterId` across a fixed claim set never changes `ranked` order | ordering invariant |
| 16 | Empty roster | all present + `warning: NO_ROSTER_SET` |
| 17 | 3-way MAIN r2 tie, BiS counts 2 / 1 / 1, mode `PHASE` | winnerGroup = the two with count 1; the count-2 claim carries `excludedReason: HIGHER_BIS_COUNT` |
| 18 | Same as 17 but mode `OFF` | all three roll |
| 19 | 3-way MAIN r2 tie, counts 2 / 1 / 0 | count-0 claim wins outright, `needsRoll = false` |
| 20 | MAIN r2 (count 5) vs OFF r1 (count 0) | MAIN r2 wins — BiS count must not cross tiers |
| 21 | MAIN r2 (count 5) vs MAIN r3 (count 0) | r2 wins — BiS count must not cross ranks |
| 22 | `bisCounts` missing a player's key | treated as 0, no crash |
| 23 | `bisCountScope: PLAYER`, player won 2 items on their alt, now claims on their main | count is 2 |

---

### 3.1 BiS count service (impure, `apps/api/src/services/bis-count.ts`)

The resolver never queries the database. A separate service computes the counts and hands them in:

```sql
-- scope=PLAYER, mode=PHASE
SELECT c.player_id AS key,
       SUM(CASE se.list WHEN 'MAIN' THEN :wMain ELSE :wOff END
           * CASE a.award_type WHEN 'OVERRIDE' THEN :wOverride ELSE 1 END) AS count
FROM awards a
JOIN submission_entries se ON se.id = a.entry_id
JOIN characters c          ON c.id = a.character_id
WHERE a.phase_id = :phaseId
  AND a.reverted_at IS NULL
  AND a.entry_id IS NOT NULL              -- excludes FREE_ROLL / DISENCHANT / BANK
  AND (:mode <> 'SESSION' OR a.raid_session_id = :sessionId)
GROUP BY c.player_id;
```

For `scope=CHARACTER`, group by `a.character_id` instead. Cache per request only — counts change after every award, and a stale count silently corrupts a live loot decision.

Expose the same numbers at `GET /api/phases/:id/standings` (player, characters, BiS count, awarded items) so the guild can see the distribution at a glance and players can verify it from their own token.



### 3.2 Decision explanation (single source of truth)

Every award must be able to answer *"why did this person get it?"* in one line, identically in the web UI, in the addon's raid-chat announcement, in the exported file, and in the imported loot log. Build it **once**, in `packages/core/src/explain.ts`, as a pure function over a `ResolveResult` plus the recorded rolls:

```ts
type WinCondition =
  | 'SOLE_CLAIM'        // only one eligible claim existed
  | 'HIGHER_PRIORITY'   // beat others on rank within the same list
  | 'MAIN_OVER_OFF'     // beat an OFF claim from the MAIN list
  | 'LOWER_BIS_COUNT'   // won the equal-distribution step outright
  | 'ROLL'              // tie resolved by dice
  | 'ADMIN_OVERRIDE'    // loot master overruled the result (reason required)
  | 'FREE_ROLL'         // nobody had it listed; open roll
  | 'DISENCHANT' | 'BANK';

type ContenderOutcome =
  | 'WON'
  | 'LOST_TIER'          // their claim was OFF, winner was MAIN
  | 'LOST_RANK'          // same list, weaker rank
  | 'SAT_OUT_BIS_COUNT'  // tied on tier+rank but had a higher BiS Count
  | 'LOST_ROLL'
  | 'NOT_PRESENT' | 'ALREADY_FULFILLED';

interface DecisionExplanation {
  itemId: number;
  winCondition: WinCondition;
  winner: { character: string; player: string; list: ListTier; rank: number; bisCount: number } | null;
  contenders: Array<{
    character: string; player: string; list: ListTier; rank: number;
    bisCount: number; outcome: ContenderOutcome; roll?: number;
  }>;
  config: { equalDistribution: string; bisCountScope: string; weightOff: number };
  /** Rendered one-liner, <= 240 chars, safe for WoW raid chat. */
  summary: string;
  decidedAt: string;
}

function explainDecision(result: ResolveResult, award: AwardRecord, rolls: RollRecord[]): DecisionExplanation;
```

**Summary templates** (implement exactly; `%s` = character name):

| Win condition | Summary |
|---|---|
| `SOLE_CLAIM` | `Thrall — MAIN #2. Only listed claim.` |
| `HIGHER_PRIORITY` | `Thrall — MAIN #2. Beats Grommash (MAIN #6).` |
| `MAIN_OVER_OFF` | `Thrall — MAIN #5. Beats Cairne (OFF #1): main list wins over off list.` |
| `LOWER_BIS_COUNT` | `Thrall — MAIN #2, 0 items so far. Grommash (2 items) and Cairne (1 item) sat out on loot spread.` |
| `ROLL` | `Thrall — MAIN #2, rolled 87. Beat Cairne (MAIN #2, rolled 43). Grommash sat out on loot spread (2 items vs 1).` |
| `ADMIN_OVERRIDE` | `Thrall — awarded by loot master. Reason: <reason>. Priority result was Cairne (MAIN #1).` |
| `FREE_ROLL` | `Thrall — open roll, 87. Nobody had this on a priority list.` |

Rules:
* The summary must always name **every contender who was excluded by the BiS Count step**, because that is the one exclusion raiders will question.
* The summary is **generated at award time and frozen** into `awards.snapshot.explanation`. Later config changes never rewrite history.
* `packages/core` owns the strings; the API, the web UI, and the exporter all read them from there. No duplicated wording anywhere.



### 3.3 List capacity (pure, `packages/core/src/capacity.ts`)

Capacity is derived, never stored, and computed by the same function on both sides of the wire:

```ts
interface CapacityResult {
  listSize: number;              // guild setting, default 17
  effective: number;             // listSize minus two-hand deductions
  deductions: Array<{ characterId: string; itemId: number; reason: 'TWOHAND_CONSUMES_OFFHAND' }>;
  blockedSlots: Array<{ characterId: string; slot: Slot; reason: string }>;  // e.g. OFF_HAND
}

function computeCapacity(
  entries: EntryInput[],
  list: ListTier,
  settings: { listSize: number; twohandConsumesOffhand: boolean },
  itemInventoryType: (itemId: number) => string
): CapacityResult;
```

The validator, the API response, and the list-builder UI all call this. Capacity is recomputed on every change: picking a 2H immediately drops the ladder from 17 to 16 rungs and greys out the off-hand row; swapping it for a one-hander restores both. If removing capacity would orphan an existing entry (the player already had 17 and then picks a 2H), the UI must refuse the change and tell the player which entry to drop first — never silently discard a ranked item.



## 3A. Multi-tenancy & isolation (NORMATIVE)

The **Guild** is the root aggregate. Everything except the item catalog belongs to exactly one guild. Treat cross-guild data leakage as a P0 security bug, not a UX flaw.

### 3A.1 Tenancy model

* **Shared database, shared schema, row-level isolation.** One Postgres instance, one schema, every tenant-owned table carries a non-nullable `guild_id`, and Postgres **Row-Level Security** enforces the boundary. Application-level `WHERE guild_id = ?` filters are a *convenience*, never the security control — one forgotten `WHERE` clause must not be able to leak data.
* A **Guild** owns: admins, phases, players, characters, invites, submissions, entries, raid sessions, attendance, awards, rolls, settings, audit log.
* **Not owned by a guild:** the `items` catalog. Item metadata is public game data, shared by all tenants, read-only at runtime. Which items are *enabled* for a phase is guild-owned (`phase_items`).

### 3A.2 Guild resolution — how a request finds its tenant

Exactly three entry paths, resolved by a single Fastify `onRequest` hook (`apps/api/src/plugins/tenant.ts`):

| Principal | How the guild is determined |
|---|---|
| **Invite token** (`/i/<token>`) | The token row carries `guild_id`. The URL contains no guild identifier. |
| **Player token** (`/b/<token>`) | Same — `access_tokens.guild_id`. |
| **Admin** | JWT claim `gid`, set at login. Login happens at `/g/:guildSlug/login`; the slug selects the guild, and the credentials are validated **within that guild only**. |

Rules:

* Tokens are globally unique 32-byte random values and are **bound to one guild at creation**. A token from guild A presented against a guild-B resource resolves to guild A and therefore finds nothing.
* The resolved `guildId` is written to `request.tenant` and to the Postgres session (`SET LOCAL app.current_guild_id`) at the start of the request transaction. **No handler may read a guild id from the request body, query string, or path.** Lint rule + code review gate on this.
* A request that resolves to no guild is rejected `401` before any handler runs.
* Cross-tenant misses return **`404`, never `403`** — a `403` confirms the resource exists and leaks tenant membership.

### 3A.3 Row-level security

Every tenant table gets the same treatment. Template:

```sql
ALTER TABLE phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE phases FORCE ROW LEVEL SECURITY;   -- applies to the table owner too

CREATE POLICY tenant_isolation ON phases
  USING      (guild_id = current_setting('app.current_guild_id', true)::uuid)
  WITH CHECK (guild_id = current_setting('app.current_guild_id', true)::uuid);
```

* The application connects as a **non-superuser, non-owner role** (`glps_app`) so RLS cannot be bypassed. Migrations run as a separate privileged role (`glps_migrate`).
* `current_setting(..., true)` returns NULL when unset, and `NULL = uuid` is NULL, so an unset session sees **zero rows**. Failing closed is the intended behaviour.
* Every request runs inside a transaction that begins with `SET LOCAL app.current_guild_id = $1`. `SET LOCAL` is transaction-scoped, so a pooled connection cannot carry a tenant context into the next request. Verify this explicitly in a test that runs two different tenants across the same pooled connection.
* A generated migration test asserts that **every table with a `guild_id` column has RLS enabled and a policy**. New tables cannot be added without one.

### 3A.4 Roles

| Role | Scope | Can |
|---|---|---|
| `INSTANCE_ADMIN` | Instance | Create/suspend/delete guilds, provision the first guild admin, view instance health and per-guild usage counts. **Cannot** read loot lists, submissions, or awards. Any elevation into a guild is explicit, time-boxed, reason-required, and written to both the instance and the guild audit logs. |
| `LOOT_MASTER` | One guild | Everything within the guild. |
| `OFFICER` | One guild | Read all; record awards and rolls; cannot unlock submissions or change guild settings. |
| `VIEWER` | One guild | Read-only admin views. |
| Player token | One guild | §7. |

An admin account belongs to exactly one guild. A human who runs two guilds gets two accounts — no cross-guild identity in v1.

### 3A.5 Per-guild configuration

The loot rules are **guild settings, not environment variables**. Every flag from §15 moves into `guild_settings`; the env vars become instance-wide *defaults applied at guild creation only*:

`equal_distribution_mode`, `bis_count_scope`, `bis_count_weight_main`, `bis_count_weight_off`, `bis_count_weight_override`, `guild_list_visibility`, `allow_alt_offspec_in_off_list`, `twohand_consumes_offhand`, `require_full_list`, `fulfill_cross_list`, `max_reserved_characters`, `list_size` (default 17), `auto_lock_on_close`.

* Settings are loaded once per request into a typed object and passed into `packages/core` as `ResolveOptions` / validator options. **`packages/core` never reads env or DB.**
* Changing a setting is audited (old value, new value, actor) and **never** rewrites frozen award explanations (§3.2).
* `list_size` is configurable because not every expansion has 17 rankable slots; it defaults to 17 and the UI derives the ladder length from it.

### 3A.6 Isolation test suite (required, blocking)

A dedicated `tenancy.spec.ts` that must pass before any milestone is accepted:

1. **Endpoint sweep:** for every route in the OpenAPI document, call it with guild-A credentials and a guild-B resource id. Expect `404`. The test enumerates routes automatically so a new endpoint cannot silently skip it.
2. **Token crossover:** a guild-A player token against `/guild/lists` returns only guild-A data; a guild-B invite token cannot claim a guild-A invite.
3. **Pooled-connection bleed:** interleave 200 requests from two guilds over a pool of 2 connections; assert zero cross-contamination.
4. **RLS-without-app:** connect directly as `glps_app` with no `app.current_guild_id` set and `SELECT count(*)` from every tenant table. Expect `0` everywhere.
5. **Raw-SQL escape:** a deliberately unfiltered `SELECT * FROM submissions` inside a request context returns only that guild's rows.
6. **Export bleed:** a guild-A export contains no guild-B player name, character name, or item claim.
7. **Uniqueness collision:** two guilds may both have a phase keyed `P3`, a player named `Thrall`, and an admin named `admin`, without conflict.
8. **Deletion:** deleting guild A leaves guild B fully intact and removes every guild-A row (verified per table).

### 3A.7 Guild lifecycle

* **Provisioning:** `make guild:create SLUG=nightfall NAME="Nightfall"` (or the instance-admin screen) creates the guild, applies default settings, and mints a one-time setup link for the first `LOOT_MASTER`. No password is ever printed to logs.
* **Suspension:** `status = SUSPENDED` → all tokens and logins for that guild return `423 GUILD_SUSPENDED`; data is retained.
* **Deletion:** two-step. `DELETE` marks `deleted_at` and revokes all tokens; a purge job hard-deletes after a configurable retention window (default 30 days). Purge is `ON DELETE CASCADE` from `guilds` and must be verified by test 8 above.
* **Data export:** `GET /api/admin/guild/export` returns the guild's complete data as JSON. A guild can leave with its data; this is also the per-tenant backup story.
* **Quotas** (soft, per guild, configurable): max phases, max players per phase, max invites per hour, max import size. Exceeding returns `429` with a clear message.



## 4. Architecture

```
                    ┌────────────────────────────┐
  browser ────────► │  web (React SPA, nginx)    │
                    └─────────────┬──────────────┘
                                  │ /api
                    ┌─────────────▼──────────────┐
                    │  api (Node 22 + Fastify)   │
                    │  ├─ tenant hook (resolves  │
                    │  │   guild, SET LOCAL)     │
                    │  ├─ packages/core (pure)   │
                    │  ├─ auth (admin JWT + gid, │
                    │  │   player bearer token)  │
                    │  └─ export/import          │
                    └─────────────┬──────────────┘
                                  │ as role glps_app (RLS enforced)
                    ┌─────────────▼──────────────┐
                    │  db (PostgreSQL 16 + RLS)  │
                    └────────────────────────────┘
```

### 4.1 Stack (fixed — do not substitute)

| Layer | Choice |
|---|---|
| Language | TypeScript (strict), Node 22 LTS |
| API | Fastify 5 + `@fastify/*` (cors, helmet, rate-limit, cookie) |
| Validation | Zod, shared between API and web via `packages/contracts` |
| ORM / migrations | Drizzle ORM + `drizzle-kit` migrations |
| DB | PostgreSQL 16 |
| Frontend | React 19 + Vite + TanStack Query + TanStack Router + Tailwind |
| Tests | Vitest (unit + integration), Playwright (2 smoke E2E flows) |
| Lint/format | ESLint flat config + Prettier |
| Container | Docker Compose (see §5) |

### 4.2 Monorepo layout

```
glps/
├─ docker-compose.yml
├─ docker-compose.override.yml        # dev: hot reload, exposed ports
├─ .env.example
├─ Makefile                            # make up / seed / test / export
├─ packages/
│  ├─ core/          # resolver, priority validation, pure domain. NO imports from api/web.
│  ├─ contracts/     # Zod schemas + inferred types, shared DTOs, addon format schemas
│  └─ item-data/     # phase item catalogs (JSON), loader + validator
├─ apps/
│  ├─ api/
│  │  ├─ src/routes/{auth,phases,invites,submissions,admin,drops,exports,imports}.ts
│  │  ├─ src/db/{schema.ts,migrations/,seed.ts}
│  │  └─ src/services/{tokens,resolver-service,export-lua,import-addon}.ts
│  └─ web/
│     └─ src/routes/{invite,submit,my-list,admin/*}
└─ docs/
   ├─ SPEC.md        # this file
   └─ ADDON_FORMAT.md
```

---

## 5. Docker Compose

`docker-compose.yml` (production-ish, single command bring-up):

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-glps}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set me}
      POSTGRES_DB: ${POSTGRES_DB:-glps}
    volumes: [ "pgdata:/var/lib/postgresql/data" ]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-glps}"]
      interval: 5s
      retries: 10

  migrate:
    build: { context: ., dockerfile: apps/api/Dockerfile, target: runner }
    command: ["node", "dist/db/migrate.js"]
    environment: { DATABASE_URL: "${DATABASE_URL}" }
    depends_on: { db: { condition: service_healthy } }
    restart: "no"

  api:
    build: { context: ., dockerfile: apps/api/Dockerfile, target: runner }
    environment:
      DATABASE_URL: "${DATABASE_URL_APP}"     # connects as glps_app — RLS enforced, NOT the table owner
      JWT_SECRET: "${JWT_SECRET:?set me}"
      TOKEN_PEPPER: "${TOKEN_PEPPER:?set me}"
      PUBLIC_BASE_URL: "${PUBLIC_BASE_URL:-http://localhost:8080}"
      NODE_ENV: production
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1))"]
      interval: 10s

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      args: { VITE_API_BASE: "/api" }
    ports: [ "8080:80" ]        # nginx serves SPA + proxies /api -> api:3000
    depends_on: { api: { condition: service_healthy } }

volumes: { pgdata: }
```

Requirements:

* `docker compose up` on a clean machine must yield a working app at `http://localhost:8080` with a seeded instance admin and two demo guilds, credentials printed to the `migrate` service logs (only if `SEED_DEMO=true`).
* The `migrate` service creates both database roles: `glps_migrate` (owner, runs DDL) and `glps_app` (non-owner, `NOLOGIN`-free login role used by the API, subject to RLS). The API must never be given the owner credentials — that would silently disable `FORCE ROW LEVEL SECURITY`.
* Multi-stage Dockerfiles, non-root user, `node:22-alpine` base, pruned dev deps in the runner stage.
* `docker-compose.override.yml` for dev: bind mounts, `tsx watch`, Vite dev server on `5173`, `adminer` on `8081`.
* No image may require network access at runtime. Item catalogs ship in the image (`packages/item-data`).

---

## 6. Data model

Drizzle schema; SQL shown for clarity. All ids are `uuid v7` except `items.item_id` (WoW item ID, integer PK).

```sql
CREATE TABLE guilds (
  id            uuid PRIMARY KEY,
  slug          text UNIQUE NOT NULL,     -- URL-safe, immutable, e.g. 'nightfall'
  name          text NOT NULL,
  realm         text,
  region        text,                     -- 'EU' | 'US' | ...
  game_version  text NOT NULL DEFAULT 'classic-era',
  status        text NOT NULL DEFAULT 'ACTIVE',   -- 'ACTIVE' | 'SUSPENDED' | 'DELETED'
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per guild. Seeded from instance defaults at creation, then owned by the guild.
CREATE TABLE guild_settings (
  guild_id                       uuid PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  list_size                      smallint NOT NULL DEFAULT 17,
  max_reserved_characters        smallint NOT NULL DEFAULT 2,
  equal_distribution_mode        text     NOT NULL DEFAULT 'PHASE',   -- OFF|PHASE|SESSION
  bis_count_scope                text     NOT NULL DEFAULT 'PLAYER',  -- PLAYER|CHARACTER
  bis_count_weight_main          numeric  NOT NULL DEFAULT 1,
  bis_count_weight_off           numeric  NOT NULL DEFAULT 0,
  bis_count_weight_override      numeric  NOT NULL DEFAULT 1,
  guild_list_visibility          text     NOT NULL DEFAULT 'AFTER_CLOSE',
  allow_alt_offspec_in_off_list  boolean  NOT NULL DEFAULT true,
  twohand_consumes_offhand       boolean  NOT NULL DEFAULT true,
  require_full_list              boolean  NOT NULL DEFAULT false,
  fulfill_cross_list             boolean  NOT NULL DEFAULT false,
  auto_lock_on_close             boolean  NOT NULL DEFAULT true,
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE instance_admins (
  id            uuid PRIMARY KEY,
  username      text UNIQUE NOT NULL,
  password_hash text NOT NULL,            -- argon2id
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admins (
  id            uuid PRIMARY KEY,
  guild_id      uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  username      text NOT NULL,
  password_hash text NOT NULL,            -- argon2id
  role          text NOT NULL,            -- 'LOOT_MASTER' | 'OFFICER' | 'VIEWER'
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, username)             -- two guilds may both have 'admin'
);

CREATE TABLE phases (
  id            uuid PRIMARY KEY,
  guild_id      uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  key           text NOT NULL,            -- 'P3', 'AQ40'
  name          text NOT NULL,
  game_version  text NOT NULL,            -- 'classic-era' | 'sod' | 'cata' | 'retail'
  status        text NOT NULL,            -- 'DRAFT' | 'OPEN' | 'LOCKED' | 'ARCHIVED'
  submissions_close_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, key)
);

-- Item catalog, seeded from packages/item-data per phase.
-- SHARED ACROSS ALL GUILDS. No guild_id, no RLS, read-only at runtime.
CREATE TABLE items (
  item_id       integer PRIMARY KEY,
  name          text NOT NULL,
  quality       smallint NOT NULL,        -- 3=rare 4=epic 5=legendary
  slot          text NOT NULL,            -- canonical Slot enum, or 'FINGER'/'TRINKET'/'WEAPON' family
  inventory_type text NOT NULL,           -- 'TWOHAND','ONEHAND','HEAD',...
  icon          text,
  source        text,                     -- boss / zone
  class_mask    integer,                  -- optional usability mask
  phase_key     text                      -- nullable; item may span phases
);
CREATE INDEX ON items (phase_key);
CREATE INDEX ON items USING gin (to_tsvector('simple', name));

-- Which catalog items a given guild's phase accepts. Guild-owned, RLS-protected.
CREATE TABLE phase_items (
  guild_id  uuid    NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  phase_id  uuid    NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  item_id   integer NOT NULL REFERENCES items(item_id),
  enabled   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (phase_id, item_id)
);

CREATE TABLE players (
  id           uuid PRIMARY KEY,
  guild_id     uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  phase_id     uuid NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  display_name text NOT NULL,             -- discord handle or main char name
  discord_tag  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phase_id, display_name)
);

CREATE TABLE characters (
  id                 uuid PRIMARY KEY,
  player_id          uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name               text NOT NULL,
  class              text NOT NULL,       -- 'WARRIOR' | ...
  main_spec          text NOT NULL,       -- 'FURY','PROT','RESTO',...
  off_spec           text,
  is_main_character  boolean NOT NULL,
  slot_index         smallint NOT NULL,   -- 1 or 2 (reserved char #)
  UNIQUE (player_id, slot_index)
);
-- Exactly one character per player may have is_main_character = true (enforced in app + partial unique index)
CREATE UNIQUE INDEX one_main_char_per_player
  ON characters (player_id) WHERE is_main_character;

CREATE TABLE invites (
  id            uuid PRIMARY KEY,
  guild_id      uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  phase_id      uuid NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  token_hash    text UNIQUE NOT NULL,     -- sha256(token || pepper), globally unique
  kind          text NOT NULL,            -- 'TARGETED' | 'GENERIC'
  prefill       jsonb,                    -- TARGETED: {characters:[{name,class,mainSpec,offSpec,isMain}]}
  label         text,                     -- admin-facing note
  max_uses      integer NOT NULL DEFAULT 1,
  used_count    integer NOT NULL DEFAULT 0,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_by    uuid REFERENCES admins(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE submissions (
  id            uuid PRIMARY KEY,
  phase_id      uuid NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  player_id     uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  invite_id     uuid REFERENCES invites(id),
  status        text NOT NULL,            -- 'DRAFT' | 'SUBMITTED'
  submitted_at  timestamptz,
  unlocked_by   uuid REFERENCES admins(id),
  unlock_reason text,
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (phase_id, player_id)
);

CREATE TABLE submission_entries (
  id            uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  character_id  uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  list          text NOT NULL,            -- 'MAIN' | 'OFF'
  rank          smallint NOT NULL,        -- 1..17
  slot          text NOT NULL,
  item_id       integer NOT NULL REFERENCES items(item_id),
  spec          text NOT NULL,            -- resolved spec used for this entry
  note          text,
  fulfilled_at  timestamptz,
  fulfilled_by_award uuid,
  UNIQUE (submission_id, list, rank),
  UNIQUE (submission_id, list, character_id, slot)
);
CREATE INDEX ON submission_entries (item_id);

CREATE TABLE access_tokens (
  id           uuid PRIMARY KEY,
  guild_id     uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  token_hash   text UNIQUE NOT NULL,      -- globally unique; carries its own tenant binding
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE raid_sessions (
  id         uuid PRIMARY KEY,
  phase_id   uuid NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  name       text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz
);

CREATE TABLE attendance (
  raid_session_id uuid NOT NULL REFERENCES raid_sessions(id) ON DELETE CASCADE,
  character_id    uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  present         boolean NOT NULL DEFAULT true,
  PRIMARY KEY (raid_session_id, character_id)
);

CREATE TABLE awards (
  id              uuid PRIMARY KEY,
  raid_session_id uuid REFERENCES raid_sessions(id),
  phase_id        uuid NOT NULL REFERENCES phases(id),
  item_id         integer NOT NULL REFERENCES items(item_id),
  entry_id        uuid REFERENCES submission_entries(id),
  character_id    uuid REFERENCES characters(id),
  award_type      text NOT NULL,          -- 'PRIORITY' | 'FREE_ROLL' | 'DISENCHANT' | 'BANK' | 'OVERRIDE'
  override_reason text,
  decided_by      uuid REFERENCES admins(id),
  awarded_at      timestamptz NOT NULL DEFAULT now(),
  reverted_at     timestamptz,
  win_condition   text,                   -- 'SOLE_CLAIM' | 'HIGHER_PRIORITY' | 'MAIN_OVER_OFF' | 'LOWER_BIS_COUNT' | 'ROLL' | 'ADMIN_OVERRIDE' | 'FREE_ROLL'
  explanation     jsonb NOT NULL,         -- frozen DecisionExplanation (§3.2), incl. rendered summary
  explanation_reported jsonb,             -- as reported by an addon import, when it differs
  review_flag     text,                   -- 'DECISION_MISMATCH' | 'EXPLANATION_INFERRED' | NULL
  snapshot        jsonb NOT NULL          -- full ResolveResult at decision time (audit)
);

CREATE TABLE rolls (
  id          uuid PRIMARY KEY,
  award_id    uuid REFERENCES awards(id) ON DELETE CASCADE,
  item_id     integer NOT NULL,
  source      text NOT NULL,              -- 'SERVER' | 'INGAME'
  results     jsonb NOT NULL,             -- [{characterId, value}]
  rolled_at   timestamptz NOT NULL DEFAULT now(),
  voided_by   uuid REFERENCES admins(id)
);

CREATE TABLE audit_log (
  id         uuid PRIMARY KEY,
  actor_type text NOT NULL,               -- 'ADMIN' | 'PLAYER' | 'SYSTEM'
  actor_id   uuid,
  action     text NOT NULL,               -- 'SUBMISSION_SUBMITTED', 'SUBMISSION_UNLOCKED', ...
  target     text,
  payload    jsonb,
  ip_hash    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 6.1 Tenancy requirements on the schema

* **Every table listed above except `guilds`, `guild_settings`, `instance_admins` and `items` carries a non-nullable, denormalized `guild_id uuid REFERENCES guilds(id) ON DELETE CASCADE`** — including `characters`, `submissions`, `submission_entries`, `raid_sessions`, `attendance`, `awards`, `rolls` and `audit_log`. Denormalized rather than joined, because RLS policies must not require a join to evaluate.
* Every such table has RLS enabled, forced, and a `tenant_isolation` policy per the §3A.3 template.
* A **trigger or check constraint** asserts that a child row's `guild_id` matches its parent's (e.g. `submission_entries.guild_id = submissions.guild_id`). Implement as a composite foreign key: `FOREIGN KEY (submission_id, guild_id) REFERENCES submissions(id, guild_id)`, which requires a `UNIQUE (id, guild_id)` on each parent. This makes a mismatched tenant physically impossible to insert.
* Every index that supports a tenant-scoped query leads with `guild_id`, e.g. `CREATE INDEX ON submission_entries (guild_id, item_id)`.
* Uniqueness constraints are scoped: `(guild_id, key)` for phases, `(guild_id, username)` for admins. Only token hashes stay globally unique.
* A migration lint test fails the build if a new table has a `guild_id` column without RLS, a policy, and a leading-`guild_id` index.

---

## 7. Authentication & tokens

Four principals:

0. **Instance admin** — separate credential store (`instance_admins`), separate login at `/instance/login`, separate cookie name. Provisioning only; see §3A.4.
1. **Guild admin** — username + password (argon2id) validated **within one guild**, selected by the `/g/:guildSlug/login` route. Short-lived JWT in an `HttpOnly; SameSite=Strict; Secure` cookie (15 min) + rotating refresh cookie (7 d), carrying claims `sub`, `role`, and **`gid` (guild id)**. The `gid` claim is the only source of tenant identity for admin requests — never the URL slug on subsequent calls, so a tampered slug cannot cross tenants. Roles: `LOOT_MASTER` (full), `OFFICER` (read + record awards), `VIEWER` (read).
2. **Invite token** — 32 bytes from `crypto.randomBytes`, base64url. Delivered as `${PUBLIC_BASE_URL}/i/<token>`. Stored **hashed** (`sha256(token + TOKEN_PEPPER)`); the plaintext is shown to the admin exactly once at creation, with a copy-to-clipboard button and a bulk "copy all as Discord-ready list" action.
3. **Player access token** — same generation/hashing, issued when the invite is claimed. URL: `${PUBLIC_BASE_URL}/b/<token>`. Sent as `Authorization: Bearer <token>` by the SPA after it reads the token from the URL path and stores it in `localStorage`. Grants:
   * read + write of **their own** submission while `status = DRAFT`; read-only after submit;
   * **read of the whole guild's priority lists, standings, and loot history** for the phase, subject to `GUILD_LIST_VISIBILITY` (below);
   * nothing else. A player token can never award loot, unlock a submission, or see invite tokens.

   `GUILD_LIST_VISIBILITY` = `AFTER_CLOSE` (default) | `ALWAYS` | `ADMIN_ONLY`. With `AFTER_CLOSE`, the guild-wide view unlocks once the phase leaves `OPEN` (or `submissions_close_at` passes) — this stops a late submitter from reading everyone else's ranks and gaming their own around them. Awards and standings are **always** visible regardless of this setting; only unsubmitted-phase wishlists are gated. Players who have not submitted see a locked state explaining why.

Rules:

* Tokens are **bound to one guild at creation** and are globally unique, so the URL needs no guild identifier and a token can never be replayed against another tenant.
* Never log or store plaintext tokens. Never return them in list endpoints (only at creation).
* Token comparison via constant-time compare on the hash.
* Rate limit: 10 req/min per IP on `/api/invites/*` and `/api/auth/login`; 60 req/min per token elsewhere. Additionally a per-guild bucket so one noisy tenant cannot degrade another.
* Admin can revoke/regenerate a player token; regeneration invalidates the old one.
* No email is collected. Distribution is manual (Discord DM by the loot master).

---

## 8. API surface

All routes prefixed `/api`. Request/response schemas live in `packages/contracts` (Zod) and are used to generate an OpenAPI 3.1 doc at `/api/openapi.json`.

**Tenancy rule for every route below:** the guild is resolved from the credential (token row or JWT `gid`), never from a parameter. No route accepts a `guildId` in its body or query. Resource ids belonging to another guild return `404`.

### 8.0 Instance admin (separate credential, separate cookie)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/instance/login`, `/instance/logout` | |
| `GET/POST` | `/instance/guilds` | List / create guilds. Creation returns a one-time setup link for the first `LOOT_MASTER`. |
| `PATCH` | `/instance/guilds/:id` | Suspend / reactivate / soft-delete; adjust quotas. |
| `GET` | `/instance/guilds/:id/usage` | Counts only: phases, players, awards, storage. **No loot data.** |
| `POST` | `/instance/guilds/:id/elevate` | Time-boxed support access, `{ reason, minutes }`. Dual-logged to the instance and guild audit trails; the guild's admins see a banner while it is active. |


### 8.1 Public / invite

| Method | Path | Notes |
|---|---|---|
| `GET` | `/invites/:token` | Returns phase info, invite kind, prefill (if targeted), catalog version. 404 on invalid/expired/revoked. |
| `POST` | `/invites/:token/claim` | Body: `{ displayName, discordTag?, characters:[{name,class,mainSpec,offSpec,isMainCharacter,slotIndex}] }` (1..2 chars). Creates player + characters + DRAFT submission. **Returns the player access token once.** Increments `used_count`. |

### 8.2 Player (Bearer player token)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/me` | Player, characters, submission status, phase deadline. |
| `GET` | `/me/submission` | Full entries for both lists, plus `capacity: { main: CapacityResult, off: CapacityResult }` so the client never recomputes the cap from assumptions. |
| `PUT` | `/me/submission` | Replace-all draft save. Body: `{ entries: EntryInput[] }`. Rejected with `409 SUBMISSION_LOCKED` if `SUBMITTED`. Runs full validation (§10) and returns structured errors. |
| `POST` | `/me/submission/submit` | Idempotent-by-version. Validates, sets `status=SUBMITTED`, `submitted_at`. **Immutable afterwards.** |
| `GET` | `/me/items?slot=&q=&class=` | Catalog search for the picker, filtered to the phase. |
| `GET` | `/me/submission/export.json` | Player's own copy (also renders a printable view in the SPA). |

**Guild-wide read (same player token, subject to `GUILD_LIST_VISIBILITY`):**

| Method | Path | Notes |
|---|---|---|
| `GET` | `/guild/lists?view=slot\|priority\|item` | The same matrix the loot master sees, read-only. Returns `403 GUILD_LISTS_LOCKED` with `unlocksAt` while submissions are open. |
| `GET` | `/guild/items/:itemId/claims` | Who wants this item, in resolved order, with list, rank and BiS Count. |
| `GET` | `/guild/standings` | Every player, their BiS Count, and the items they received. Never gated. |
| `GET` | `/guild/loot?sessionId=` | Loot history feed. Each row carries the frozen `DecisionExplanation` — item, winner, win condition, contenders, rolls, and any BiS-Count exclusions. Never gated. |

### 8.3 Admin (JWT cookie)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/login`, `/auth/logout`, `/auth/refresh` | Login is `POST /g/:guildSlug/auth/login`; the slug is used once, to select the guild. |
| `GET/PATCH` | `/admin/guild` | Guild profile (name, realm, region). |
| `GET/PATCH` | `/admin/guild/settings` | The per-guild loot rules from §3A.5. Every change is audited with old and new values. |
| `GET` | `/admin/guild/export` | Full guild data export (JSON) — portability and per-tenant backup. |
| `GET/POST/DELETE` | `/admin/users` | Manage this guild's admin accounts. Cannot see or touch other guilds' accounts. |
| `GET/POST/PATCH` | `/phases`, `/phases/:id` | status transitions `DRAFT→OPEN→LOCKED→ARCHIVED` |
| `POST` | `/phases/:id/invites` | Body: `{ kind, count?, prefill?, label?, expiresAt?, maxUses? }`. Bulk create for `GENERIC`. Returns plaintext tokens once. |
| `GET` | `/phases/:id/invites` | Status list; never returns plaintext. |
| `POST` | `/invites/:id/revoke` | |
| `GET` | `/phases/:id/submissions` | Summary: player, chars, status, entry counts, missing-list flags. |
| `GET` | `/phases/:id/submissions/:playerId` | Full detail. |
| `POST` | `/phases/:id/submissions/:playerId/unlock` | Body `{ reason }`. Audited. Sets `DRAFT`, bumps `version`. |
| `GET` | `/phases/:id/matrix?view=slot\|priority\|item` | The main admin table (§11.3). |
| `GET` | `/phases/:id/items/:itemId/claims` | Sorted claim list for one item, ignoring attendance. |
| `POST` | `/phases/:id/drops/resolve` | Body `{ itemId, raidSessionId? , presentCharacterIds? }` → `ResolveResult`. **Read-only, no persistence.** |
| `POST` | `/phases/:id/rolls` | Body `{ itemId, characterIds[], source, results? }` → persists roll. |
| `POST` | `/phases/:id/awards` | Body `{ itemId, entryId? , characterId?, awardType, rollId?, overrideReason? }`. Persists award + `snapshot`. |
| `POST` | `/awards/:id/revert` | Audited. |
| `GET/POST` | `/phases/:id/raid-sessions`, `/raid-sessions/:id/attendance` | |
| `GET` | `/phases/:id/export?format=addon-lua\|addon-json\|json\|csv` | §9 |
| `POST` | `/phases/:id/import` | §9.3 |
| `GET` | `/phases/:id/audit` | Paginated audit log. |

**Error contract:** every 4xx returns `{ error: { code, message, details? } }` with stable machine codes (`SUBMISSION_LOCKED`, `RANK_GAP`, `DUPLICATE_SLOT`, `SPEC_NOT_ALLOWED_IN_LIST`, `ITEM_NOT_IN_PHASE`, `INVITE_EXPIRED`, ...).

---

## 9. Addon interoperability

The loot master runs an in-game addon. It is a **separate project**; this system only owns the data contract, documented in `docs/ADDON_FORMAT.md`.

### 9.1 Export — Lua SavedVariables (`format=addon-lua`)

The critical design point: the addon must answer "who wants this item?" **instantly, offline, keyed by item ID**. So the export contains a **pre-computed, pre-sorted claim index by item ID**, not raw lists.

```lua
GLPS_DB = {
  schema = 1,
  guild = "nightfall",                   -- guild slug; the addon keeps one DB per guild
  guildId = "0192f3c1-…",                -- opaque; imports are rejected if it does not match
  phase = "P3",
  generatedAt = 1756512000,
  checksum = "sha256:ab12…",     -- over the canonical JSON, for staleness detection
  players = {
    ["Thrall"] = { class = "SHAMAN", mainSpec = "ENHANCEMENT", offSpec = "RESTORATION",
                   isMain = true, player = "thrall#1234", alts = { "Thrallalt" } },
  },
  -- pre-sorted: index 1 is the strongest claim
  items = {
    [19019] = {
      { c = "Thrall",    t = "MAIN", r = 1,  s = "MAIN_HAND", p = "thrall#1234" },
      { c = "Grommash",  t = "MAIN", r = 4,  s = "MAIN_HAND", p = "grom#1234"   },
      { c = "Cairne",    t = "OFF",  r = 2,  s = "MAIN_HAND", p = "cairne#1234" },
    },
  },
  awarded = {
    { item = 19019, c = "Thrall", at = 1756512345,
      win = "ROLL",
      why = "Thrall — MAIN #2, rolled 87. Beat Cairne (MAIN #2, rolled 43). Grommash sat out on loot spread (2 items vs 1).",
      det = {                                    -- structured form of the same decision
        w = { c = "Thrall", t = "MAIN", r = 2, b = 0, roll = 87 },
        o = { { c = "Cairne",   t = "MAIN", r = 2, b = 0, roll = 43, out = "LOST_ROLL" },
              { c = "Grommash", t = "MAIN", r = 2, b = 2,            out = "SAT_OUT_BIS_COUNT" } },
      },
    },
  },
  -- BiS Count per player at export time, so the addon can show the tiebreak in-game
  bisCounts = { ["thrall#1234"] = 2, ["grom#1234"] = 1 },
  config = { equalDistribution = "PHASE", bisCountScope = "PLAYER", weightOff = 0 },
}
```

Field abbreviations (`c`,`t`,`r`,`s`,`p`) are intentional — SavedVariables files get large and are parsed in-game.

Rules:
* Output must be **valid Lua 5.1**, deterministic key ordering, `\n`-terminated, UTF-8 without BOM.
* Ties (equal `t` + `r`) are emitted adjacent and each carries `tie = true` so the addon can prompt for `/roll`.
* Each claim entry additionally carries `b = <bisCount>`, so the addon can grey out and label claimants who would sit out under the equal-distribution rule **before** the loot master decides — the in-game view must match the web result exactly.
* The addon is expected to announce `why` in raid chat when loot is assigned. That string is generated by this system (§3.2), never by the addon, so the wording is identical everywhere.
* Fulfilled entries are excluded from `items` but listed in `awarded` with their frozen explanation.
* Served as a file download named `GLPS_<phaseKey>_<yyyymmdd-HHMM>.lua`, plus a copy-to-clipboard textarea in the UI (`addon-json` variant for addons that prefer an import string).

### 9.2 Export — `addon-json`

Same tree as 9.1 but JSON, optionally wrapped as an import string: `GLPS1:<base64url(deflate(json))>`. Provide both raw and wrapped; the wrapped variant is what players paste into an addon's import box. Implement `packages/core/src/codec.ts` with `encodeImportString` / `decodeImportString` and round-trip tests.

### 9.3 Import — from addon → server

`POST /api/phases/:id/import` accepts either a JSON body or a pasted import string. Schema (Zod, versioned by `schema`):

```jsonc
{
  "schema": 1,
  "phase": "P3",
  "raidSession": { "name": "AQ40 Wed", "startedAt": 1756512000 },
  "attendance": [ { "character": "Thrall", "present": true } ],
  "loot": [
    {
      "itemId": 19019,
      "character": "Thrall",
      "at": 1756512345,
      "awardType": "PRIORITY",
      "winCondition": "ROLL",
      "rolls": [ { "character": "Thrall", "value": 87 }, { "character": "Cairne", "value": 43 } ],
      "contenders": [
        { "character": "Cairne",   "list": "MAIN", "rank": 2, "bisCount": 0, "outcome": "LOST_ROLL", "roll": 43 },
        { "character": "Grommash", "list": "MAIN", "rank": 2, "bisCount": 2, "outcome": "SAT_OUT_BIS_COUNT" }
      ],
      "note": "free text from the loot master, optional"
    }
  ]
}
```

The `winCondition` / `contenders` / `rolls` block is what turns the import into a **complete audit record**: after importing a raid night, the guild-wide loot feed shows every item, who got it, and why — including who was skipped for having a higher BiS Count — without the loot master retyping anything.

Behaviour:

* **Guild binding is checked first.** If the payload's `guildId` does not match the authenticated guild, the import is rejected `409 GUILD_MISMATCH` before anything is parsed — a loot master must not be able to paste another guild's raid into their own history, deliberately or by accident. A payload with no `guildId` (older addon) is accepted with a warning.
* **Dry-run first.** The endpoint requires `?commit=true` to write; without it, returns a diff preview: matched characters, unmatched names, awards that would be created, entries that would be fulfilled, conflicts.
* Character matching is case-insensitive on name within the phase; realm suffixes (`Name-Realm`) are stripped. Unmatched names are reported, never auto-created.
* Idempotent: `(itemId, character, at)` dedupe key. Re-importing the same file is a no-op.
* An imported award that does not match the resolver's winner is still accepted but flagged `award_type = OVERRIDE` with `override_reason = "imported: differs from priority result"` and surfaced in a review queue.
* **Decision reconciliation:** the server recomputes the decision from its own data as of the award timestamp and compares it with the imported `winCondition` / `contenders`. On a match, the imported explanation is stored as-is. On a mismatch, both are stored (`explanation` = server-computed, `explanation_reported` = imported) and the row is flagged `DECISION_MISMATCH` in the review queue. The server's version is what the guild-wide feed shows; the imported version is kept for the audit trail. Never silently discard either.
* If `contenders` or `rolls` are absent (an older addon build), the server computes and stores its own explanation and marks the row `EXPLANATION_INFERRED`.
* Also accept a **CSV** loot log (`itemId,character,timestamp,note`) for addons that only export CSV.

---

## 10. Validation rules (submission)

Implemented once in `packages/core/src/validate.ts`, called by both the API and the web form so the UI can show errors live.

**Blocking errors:**

| Code | Rule |
|---|---|
| `RANK_GAP` | Ranks within a list must be `1..N` contiguous, no duplicates. |
| `RANK_OUT_OF_RANGE` | `1 <= rank <= effectiveCapacity(list)`. |
| `TOO_MANY_ENTRIES` | Entries per list must not exceed `effectiveCapacity(list)` (§2.2). The error message states the cap and why it is reduced, e.g. *"15 of 15 — two two-handed weapons each consume an off-hand slot."* |
| `OFFHAND_BLOCKED_BY_TWOHAND` | When `twohand_consumes_offhand = true`: a character with a `TWOHAND` item in `MAIN_HAND` may not have an `OFF_HAND` entry in the same list. |
| `DUPLICATE_SLOT` | Same `(list, character, slot)` twice. |
| `DUPLICATE_ITEM_IN_LIST` | Same `(list, character, item_id)` twice. |
| `SPEC_NOT_ALLOWED_IN_LIST` | MAIN list entries must use a reserved character's **main spec**. OFF list entries must use char#1 off spec, char#2 main spec, or (if enabled) char#2 off spec. |
| `ITEM_NOT_IN_PHASE` | `item_id` must exist in the catalog and be enabled for the phase. |
| `ITEM_SLOT_MISMATCH` | The item's inventory type must be compatible with the declared slot (rings→FINGER_1/2, trinkets→TRINKET_1/2, 2H→MAIN_HAND). |
| `CHARACTER_NOT_OWNED` | `character_id` must belong to the submitting player. |
| `SUBMISSION_LOCKED` | Any write while `status = SUBMITTED`. |
| `PHASE_CLOSED` | Phase `status != OPEN` or past `submissions_close_at`. |

**Non-blocking warnings** (shown, do not prevent submission):

* `TWOHAND_WITH_OFFHAND` — only when `twohand_consumes_offhand = false`; otherwise this is the blocking `OFFHAND_BLOCKED_BY_TWOHAND` error above.
* `CLASS_CANNOT_USE_ITEM` (armor type / class mask mismatch)
* `EMPTY_OFF_LIST`
* `SLOT_NOT_COVERED` (a slot appears in neither list)
* `ITEM_ALSO_IN_OTHER_LIST` (informational)

---

## 11. Frontend

Design constraints: dark, dense, keyboard-friendly, mobile-usable (loot masters use phones at raid). Follow the `frontend-design` skill guidance for visual direction; do not ship default-Tailwind-looking screens. WoW class colors are used for character names — define them once as CSS custom properties.

### 11.1 Invite / onboarding (`/i/:token`)

* **Targeted invite:** shows the pre-filled character(s) read-only; the player confirms and optionally corrects the off spec.
* **Generic invite:** form for `displayName`, then 1–2 character cards (name, class dropdown → main spec / off spec dropdowns filtered by class, `is main character` toggle).
* On claim: full-screen "**Save this link**" panel with the personal URL, a QR code, a copy button, and a warning that it is shown only once (recoverable only by an admin).

### 11.2 List builder (`/b/:token`)

The core UX. Two tabs: **Main list** and **Off list**.

* Left: the 17 slots as rows. Each row has a character selector (only when 2 chars are reserved), an item picker (searchable by name **and by item ID**, showing icon + quality color + source boss), and a note field. Picking a two-handed weapon immediately greys the off-hand row for that character with an inline note ("blocked — two-handed weapon uses both hands"); the row stays visible rather than disappearing, so the rule is legible.
* Right: the **priority ladder** — a drag-and-drop ordered list of the chosen items, positions `1..effectiveCapacity`, with the rank number large and readable. The ladder length is **dynamic**: choosing a 2H shortens it from 17 to 16 rungs, with a visible "16 of 16 — two-handed weapon uses your off-hand slot" caption. Removing the 2H restores the rung. Drag reorder rewrites ranks contiguously.
* If a change would shrink capacity below the number of ranked entries, the picker refuses and names the entry to remove first. Ranked items are never silently dropped.
* A persistent validation panel showing blocking errors and warnings.
* Autosave draft (debounced `PUT /me/submission`), with a visible "Saved 12:04" indicator.
* **Submit** opens a confirmation modal that restates: *"This is final. You will not be able to change your list. Contact the loot master if you need a correction."* Requires typing `SUBMIT` or checking an explicit box.
* After submission: read-only view of both lists, printable, exportable to JSON, with fulfillment status per entry once awards start landing.

### 11.2b Guild view (`/b/:token/guild`)

Read-only, reachable from the player's own list page. Same data, same components as the admin matrix, no mutation controls.

* **Lists** — the slot/priority/item matrix for the whole raid. Locked with an explanatory panel and an `unlocksAt` countdown while `GUILD_LIST_VISIBILITY=AFTER_CLOSE` and submissions are still open.
* **Standings** — every player, their BiS Count, and what they've received. Always visible.
* **Loot feed** — reverse-chronological list of awards. Each row shows the item, the winner, and the frozen `summary` from §3.2, expandable into the full contender table with ranks, BiS Counts and roll values. This is the screen that answers "why did he get that and not me" without anyone asking the loot master.
* Every column is sortable; the feed is filterable by player, item, slot and win condition.



### 11.3 Admin console (`/admin`)

* **Dashboard:** phase status, submitted vs invited count, days until close, missing submissions list with copy-invite buttons.
* **Matrix view** — the primary requested screen. A table with **players as rows, the 17 slots as columns**, each cell showing the item + a rank badge, colored by list (MAIN accent / OFF muted). Toggle between:
  * `view=slot` — slot columns (default).
  * `view=priority` — priority columns 1..17, cell shows slot + item.
  * `view=item` — grouped by item, listing every claimant in resolved order (this is the one used live).
  * Filters: list (MAIN/OFF/both), class, character, slot, boss/source. Sticky header + first column. CSV export of the current view.
* **Drop resolver** — a single big item search box ("paste item link or ID"). Shows the resolved claim list: winner highlighted, tie group flagged, with buttons `Award`, `Roll`, `Award to other (override, reason required)`, `Disenchant`. Every row shows the claimant's **BiS Count** as a badge; rows dropped by the equal-distribution step are rendered greyed with an inline explanation ("sits out — 2 items vs 1") rather than hidden, so the loot master can defend the call in raid chat. A one-click toggle recomputes the result with `EQUAL_DISTRIBUTION_MODE=OFF` for comparison, without changing the saved config. Optimized for a phone screen.
* **Standings** — table of players sorted by BiS Count, with the items each has received. Public to players via their own token (read-only), because a fairness rule nobody can audit will not be trusted.
* **Raid session** — roster toggles for attendance, live award feed with undo.
* **Exports/Imports** — download buttons, import dry-run diff view.
* **Audit** — filterable log.

---

## 12. Item catalog

* `packages/item-data/<gameVersion>/<phaseKey>.json`: `[{ itemId, name, quality, inventoryType, slot, icon, source, classMask }]`.
* Seeded into `items` by the `migrate`/`seed` job; idempotent upsert keyed on `item_id`.
* Ship at least one real catalog so the system is demoable out of the box. If a full dataset is not available at build time, ship a **documented, clearly-labelled sample catalog** (`sample-p3.json`, ≥ 60 items covering all 17 slots) and a `pnpm run catalog:import <file.csv>` command for the guild to load their own. **Do not scrape any website at build or runtime.**
* Optional (behind `BLIZZARD_CLIENT_ID/SECRET`, default off): a one-shot sync command against the Blizzard Game Data API to refresh names/icons. Must degrade silently when unset.
* Item icons: reference by icon name; render from a local sprite/asset directory or fall back to a quality-colored placeholder. No runtime CDN dependency.

---

## 13. Non-functional requirements

* **Determinism:** the resolver must be deterministic apart from explicit dice rolls. Every award persists a full `snapshot` of the inputs and result.
* **Performance:** matrix and resolver endpoints must serve a 40-player phase in <200 ms p95. Index `submission_entries(item_id)` and `(submission_id, list, rank)`.
* **Concurrency:** submission writes use optimistic locking on `submissions.version`; `POST /submit` is transactional and idempotent.
* **Timezones:** store UTC; render in the browser's locale; show deadlines with an explicit timezone label.
* **Backups:** `make backup` → `pg_dump` to `./backups`; document restore.
* **Observability:** structured JSON logs (pino) with request ids; `/healthz`, `/readyz`.
* **Tenant isolation:** enforced in the database (RLS), not the application. Cross-tenant access is a P0 bug class with a blocking test suite (§3A.6). Logs and metrics carry `guild_id` as a label; error reports never include another tenant's identifiers.
* **Security:** helmet, strict CORS (`PUBLIC_BASE_URL` only), CSRF-safe cookie config, rate limits (per IP, per token, per guild), no plaintext tokens at rest, argon2id for passwords, no PII beyond a Discord handle.
* **Accessibility:** keyboard-operable drag-and-drop (arrow-key reorder fallback), WCAG AA contrast, screen-reader labels on rank controls.

---

## 14. Milestones (agent work breakdown)

Each milestone ends green: typecheck, lint, tests, and `docker compose up` working.

| M | Deliverable | Definition of done |
|---|---|---|
| **M0** | Monorepo scaffold, Docker Compose, CI, Postgres + Drizzle migrations, healthchecks, **DB roles (`glps_app` / `glps_migrate`) and the RLS migration lint** | `docker compose up` serves a "hello" SPA and `/healthz`; `make test` runs; a table without a policy fails the build |
| **M0b** | Tenancy foundation: `guilds`, `guild_settings`, `instance_admins`, tenant resolution hook, `SET LOCAL`, RLS policies on every tenant table, guild CLI provisioning | `tenancy.spec.ts` (§3A.6) passes with two seeded guilds; **no later milestone is accepted while any of its 8 cases fail** |
| **M1** | `packages/core`: types, resolver, validator, codec | All resolver cases + validator cases pass; 100% branch coverage on `core`; **no dependency on api/web, no env or DB access** |
| **M2** | DB schema + seed + item catalog import + per-guild settings CRUD | `make seed` creates **two** guilds, each with an admin, a phase, and 3 fixture players with valid lists — so every later feature is developed against a multi-tenant fixture, not a single-guild one |
| **M3** | Auth + invites (admin login, targeted/generic invite creation, claim flow, player tokens) | Integration tests for expiry, revoke, max-uses, token hashing, replay |
| **M4** | Player list builder (API + UI), draft autosave, submit + immutability | Playwright E2E: claim invite → build both lists → submit → verify locked |
| **M5** | Admin console: matrix (3 views), submission detail, unlock with audit | Matrix renders 40 players × 17 slots without virtualization jank |
| **M6** | Drop resolver UI, rolls, awards, revert, raid sessions, attendance, `explainDecision` + frozen snapshots | Playwright E2E: resolve tie → roll → award → entry fulfilled → re-resolve excludes it; every award renders a correct one-line summary naming BiS-Count exclusions |
| **M6b** | Guild-wide read view (`/b/:token/guild`): lists, standings, loot feed with explanations; `GUILD_LIST_VISIBILITY` gating | A player token can read the guild matrix after close and is refused before it; standings and loot feed always readable |
| **M7** | Export (`addon-lua`, `addon-json`, `json`, `csv`) incl. per-award `why`/`det`; import (dry-run + commit) incl. decision reconciliation | Round-trip test: export → import → zero diff; a mismatched imported decision lands in the review queue; `docs/ADDON_FORMAT.md` complete |
| **M8** | Instance-admin screen (guild list, create, suspend, quotas, elevate-with-reason), hardening: rate limits, audit log UI, backups, README, `.env.example`, ops docs | Fresh-clone → `cp .env.example .env && docker compose up` → two guilds provisioned and usable in <5 min |

**Suggested parallelization:** M0b must complete before anything touching the database. M1 (pure core) can run fully in parallel with M0/M0b. M4 and M5 can run concurrently after M3. M7 depends only on M2 + M1.

**Standing rule for every milestone:** each new endpoint is added to the automatic route sweep in `tenancy.spec.ts`. A PR that adds a route without a passing cross-tenant `404` case is not mergeable.

---

## 15. Open decisions (do NOT resolve unilaterally)

| ID | Question | Default to implement | Setting |
|---|---|---|---|
| ~~D-1~~ | ~~Should a main character beat an alt on an exact tier+rank tie?~~ | **RESOLVED — no.** Main/alt is not a comparison component at all; the two-list model fully replaces it. Ties always roll. No config flag; do not implement one. | — |
| ~~D-2~~ | ~~Should a player who already won an item be deprioritized on later ties?~~ | **RESOLVED — yes, configurable.** Implemented as the BiS Count tiebreak, §2.4.1. Default `EQUAL_DISTRIBUTION_MODE=PHASE`. | `EQUAL_DISTRIBUTION_MODE`, `BIS_COUNT_SCOPE`, `BIS_COUNT_WEIGHT_*` |
| ~~D-2a~~ | ~~Should offspec wins count toward BiS Count?~~ | **RESOLVED — no.** Offspec loot is free. | `BIS_COUNT_WEIGHT_OFF=0` |
| **D-8** | When should the guild-wide list view unlock for players? | **After submissions close** — prevents late submitters gaming their ranks. Standings and loot history are always visible. | `GUILD_LIST_VISIBILITY=AFTER_CLOSE` |
| **D-3** | May a player's second character use its **off spec** in the OFF list? | **Yes** | `ALLOW_ALT_OFFSPEC_IN_OFF_LIST=true` |
| **D-4** | Must every rank up to the effective capacity be filled to submit? | **No** — partial lists allowed, contiguous ranks required | `REQUIRE_FULL_LIST=false` |
| **D-5** | Can the same slot appear twice in one list across two characters? | **Yes** (required by the split-main rule) | — |
| **D-6** | Does an OFF-list win fulfill the corresponding MAIN entry for the same item? | **No** — only the winning entry is fulfilled | `FULFILL_CROSS_LIST=false` |
| **D-7** | Should submissions auto-lock at `submissions_close_at`? | **Yes**, phase transitions to `LOCKED` | — |

| **D-11** | Should a two-handed weapon consume the off-hand slot, reducing the list to 16? | **Yes**, blocking. Reverts to a warning with full 17 capacity when disabled. | `twohand_consumes_offhand=true` |
| **D-9** | Guild routing: path prefix (`/g/nightfall/...`) or subdomain (`nightfall.host`)? | **Path prefix** — no wildcard DNS, no wildcard TLS, works behind any reverse proxy, simpler local dev. Subdomains can be layered on later without a schema change. | — |
| **D-10** | Should the item catalog be shared across guilds or per-guild? | **Shared**, read-only. Per-guild *enablement* via `phase_items` covers the real need (which items a phase accepts) without duplicating catalog rows per tenant. | — |

Every setting in this table lives in `guild_settings` (§3A.5), **not** in the environment. The env vars of the same name only supply instance-wide defaults applied at guild creation; changing an env var never alters an existing guild. Read the settings once per request into a typed object and pass them into `packages/core` as `ResolveOptions` / validator options — never read env vars or the database inside `packages/core`. Document the instance defaults in `.env.example` with comments.

---

## 16. Acceptance criteria (final review checklist)

1. `git clone && cp .env.example .env && docker compose up` yields a working system with a seeded admin.
2. A loot master can create a phase, generate 25 generic invites and 5 targeted invites, and copy them in one action.
3. A player can claim an invite, register two characters, split 17 main priorities across both characters' main specs, fill an off list, and submit. A second submit attempt fails with `SUBMISSION_LOCKED`.
4. The player can reopen their personal link a day later and see their list read-only.
5. The admin matrix shows every player's slot × priority assignments and filters correctly.
6. The worked example in §2.4 produces exactly the documented outcomes through the HTTP API.
7. A MAIN rank-17 claim beats an OFF rank-1 claim, and a MAIN rank-5 claim on an alt character beats an OFF rank-1 claim on a main character — verified by test and reproducible in the UI. No code path anywhere compares main vs alt character to decide loot.
8. A tie triggers a roll; the roll and the award are persisted with an audit snapshot; reverting the award un-fulfills the entry.
9. Export produces a Lua file that loads without error in a Lua 5.1 interpreter (`lua -e "loadfile('out.lua')()"` in CI) and contains a pre-sorted claim list per item ID.
10. Importing an addon loot log in dry-run mode shows a diff; committing it creates awards and fulfills the right entries; re-importing changes nothing.
11. With `EQUAL_DISTRIBUTION_MODE=PHASE`, three claimants tied at MAIN rank 2 with BiS Counts 2/1/1 produce a two-way roll; the excluded claimant is visible in the UI with a stated reason. Setting the mode to `OFF` and re-resolving produces a three-way roll. Reverting an award decrements the count immediately.
12. Every award produces a frozen one-line explanation naming the win condition, and it names every claimant excluded by the BiS Count step. Changing config afterwards does not alter past explanations.
13. A player token opens the guild-wide view: full matrix after submissions close (refused before, with an unlock time), plus standings and a loot feed where each row expands into ranks, BiS Counts and roll values.
14. Importing an addon loot log with `winCondition` and `contenders` reproduces the same explanation the web UI would have generated; a deliberately falsified import is flagged `DECISION_MISMATCH` and both versions are retained.
15. Two guilds run on one deployment with identical phase keys, character names and admin usernames, without collision. Guild A's loot master cannot see, resolve, export, or import anything belonging to guild B; every cross-tenant attempt returns `404`.
16. All 8 cases of `tenancy.spec.ts` (§3A.6) pass, including the direct-database check that `glps_app` with no tenant context reads zero rows from every tenant table.
17. Guild loot rules are per-guild: guild A can run `EQUAL_DISTRIBUTION_MODE=PHASE` with `BIS_COUNT_WEIGHT_OFF=0` while guild B runs `OFF` with weight `1`, simultaneously, and each guild's resolver output reflects only its own settings.
18. Deleting a guild removes all of its rows and leaves the other guild byte-identical.
19. With `twohand_consumes_offhand=true`, a player who ranks a two-handed weapon sees the ladder drop to 16 rungs, cannot add an off-hand entry for that character in the same list, and can still list a shield in the OFF list for their off spec. Two reserved characters both listing a 2H in the MAIN list yields a cap of 15. Disabling the setting restores 17 and downgrades the conflict to a warning.
20. No plaintext token exists in the database or in any log line.
