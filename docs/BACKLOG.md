# Backlog & handoff notes

Last updated 2026-09-07. Start here before picking up new work — it points
at what's genuinely unbuilt, what's been deliberately deferred (and why),
and a couple of process landmines worth knowing about before touching
migrations or the Wowhead integration.

## Unbuilt spec features

From `docs/SPEC.md`, still not built as of this doc:

- **§11.2b Guild-wide read view** (`/b/:token/guild` — lists/standings/loot
  feed, gated by `GUILD_LIST_VISIBILITY`). Nothing built yet, API or UI.
- **§9.3 Addon import** (`POST /phases/:id/import`, dry-run + commit,
  decision reconciliation). The export half (§9.1/§9.2) is done and
  battle-tested; `packages/core/src/codec.ts`'s `encodeImportString`/
  `decodeImportString` already round-trip; only the HTTP route and the
  reconciliation logic against `zImportLootRow` are missing.
- **Raid-session / attendance CRUD UI.** The `raid_sessions`/`attendance`
  tables and `presentCharacterIdsFor` (used by drop resolution) exist;
  there's no admin UI to create a session or toggle attendance.
- **Instance admin: `PATCH /instance/guilds/:id`** (suspend/quotas),
  **`GET .../usage`**, **`POST .../elevate`**. Login, guild list, and guild
  creation are done (§8.0). Deliberately scoped out of
  `docs/superpowers/specs/2026-09-05-instance-admin-guild-registration-design.md`
  — pick that doc's follow-up scope when starting this.
- **Audit log UI**, **backups** (`make backup`/restore docs), **rate limits
  beyond the global default** (§13's per-IP/per-token/per-guild buckets
  are unimplemented past the base 300/min).

## Deferred code-review findings

These were found and explicitly deferred (not forgotten) during past final
reviews. None are exploitable tenancy defects; all are small.

- **`instance_admins` has over-broad `glps_app` grants** (INSERT/UPDATE/
  DELETE from the blanket `ALTER DEFAULT PRIVILEGES` in `migrate.ts`, but
  no API route ever writes to it — only reads for login). Worth a
  `REVOKE INSERT, UPDATE, DELETE ON instance_admins FROM glps_app` in a
  follow-up migration, defense in depth on the highest-privilege
  credential store in the system.
- **No audit-log entry for instance-admin actions** (guild creation,
  setup-link claim) despite §3A.4 describing instance-admin actions as
  audited. `audit_log` is guild-scoped with an `actor_type` column — a
  `GUILD_CREATED`/`ADMIN_SETUP_CLAIMED` row is cheap to add.
- **`migrate.ts`'s instance-admin seed is keyed on username**
  (`ON CONFLICT (username) DO UPDATE`). Changing `INSTANCE_ADMIN_USERNAME`
  in `.env` creates a *second* instance admin and silently leaves the old
  one active with its old password. At minimum needs a comment; ideally a
  warning log when more than one row exists.
- **`/instance/login` has no tighter rate limit than the global 300/min**,
  despite `app.ts`'s own comment flagging login routes as needing one —
  matches a pre-existing gap on `/g/:slug/auth/login`, not a regression,
  but instance-admin is the highest-value credential in the system.
- **Instance dashboard's guild-list status pill is hardcoded green**
  regardless of actual `status` — harmless today since nothing can set a
  guild non-`ACTIVE` until `PATCH /instance/guilds/:id` lands (see above),
  but that's precisely the screen whose job is to surface it.
- **Expired instance session renders an empty-looking dashboard** instead
  of a "session expired" message (`guilds.error` isn't handled) — the
  guild-admin dashboard has the exact fix as precedent two directories
  over.
- **No `apps/api/test/http-tenancy.spec.ts`** — the design doc for the
  instance-admin feature anticipated an automatic sweep asserting every
  registered route declares a `tenant` config, with `instance`/
  `admin-setup` on an explicit allowlist. It doesn't exist. This is the
  structural control that would have caught the `mode === 'instance'`
  silent-no-op bug (fixed this session, commit `862b712`) automatically
  instead of by manual review — worth building before the next new
  `TenantMode` is added.
- **`instance-guilds.ts`'s `23505` catch wraps all 4 inserts** in the
  single guild-creation transaction (guild, guild_settings, admin,
  admin_setup_tokens), so a unique-constraint violation from the admin or
  setup-token insert would be misreported as "slug already taken."
  Practically unreachable (fresh uuidv7 ids, random token) but worth
  narrowing to `err.constraint?.includes('slug')`.
- **The atomic setup-token claim's route-level guard is untested** — the
  DB function (`mark_admin_setup_token_used`) has a direct test; the
  route's `if (!marked) throw unauthorized(...)` branch is only reachable
  in a true concurrent-claim race, which no test simulates.
- **No admin UI to remove an `acquiredVia` mapping** distinct from
  re-attaching the item without one (existing upsert semantics already
  clear it, just not from a dedicated "remove mapping" affordance).
- **No validation that a token's real items are all in the same phase**,
  or any cross-check against Wowhead's own (undocumented, unreliable)
  idea of which items a token produces — the `acquiredVia` mapping is
  purely admin-entered data, by design (see
  `docs/superpowers/specs/2026-09-07-token-and-quest-item-acquisition-design.md`'s
  "Deliberately out of scope").

## Known environmental issues

- **`.env`'s `PUBLIC_BASE_URL=http://localhost:8080` doesn't match the dev
  override stack's actual web port (5173).** Generated setup/invite URLs
  need manual port substitution when testing locally with
  `docker compose up` (the override file puts Vite's dev server on 5173,
  not behind nginx on 8080). Affects `invites.ts` and `instance-guilds.ts`
  both. Not introduced by any feature — worth fixing centrally (e.g. read
  the actual bound port, or document the substitution prominently) rather
  than patching per-caller.
- **Wowhead scraping has no stability monitoring.** `apps/api/src/services/
  wowhead-item.ts` has no documented API to depend on and no contract with
  Wowhead — see the deviation note in `docs/SPEC.md` §12 for what depends
  on it. It already broke once this session in a different but adjacent
  place (the tooltip *widget's* URL, `wow.zamimg.com/js/power.js` →
  `/widgets/power.js` — see the README's key design notes). If the item-page
  scraping breaks the same way, every caller already handles it as
  `WOWHEAD_FETCH_FAILED` (502) — but nothing currently *notices* or alerts
  on a sustained failure. A periodic smoke test against a known-stable
  item ID (e.g. 19019, Thunderfury) would catch it early.

## Process notes for whoever picks this up next

- **Migration timestamps must be strictly increasing.** `drizzle-kit
  generate` stamps a new migration's `meta/_journal.json` entry with
  `Date.now()` at generation time — it does **not** check that against a
  hand-edited prior entry. This silently broke three migrations in a row
  this session (`0006`, `0007`, `0008`): a `when` in an earlier migration
  that happened to be later than "now" caused drizzle-orm's migrator to
  skip every migration after it on the database's *first* run (subsequent
  runs look fine because the earlier ones are already marked applied — the
  bug only manifests once, against a fresh DB, which is exactly when it's
  easiest to miss). **After every `drizzle-kit generate`, check the new
  entry's `when` against the previous one and bump it if it's not strictly
  greater.**
- **Design docs precede non-trivial features.** Every extension in this
  repo past the original `docs/SPEC.md` has a design doc under
  `docs/superpowers/specs/` (some have a task plan under
  `docs/superpowers/plans/` too) written and approved *before*
  implementation. Keep doing that — it's what keeps this backlog file
  honest, and it's cheap insurance against building the wrong thing.
- **No git worktree in use on this branch.** Every feature this session
  was built directly on `claude/new-session-a6cgcz` (a session-scoped
  branch already, so isolation wasn't needed) — an earlier session did use
  a worktree for the phase-item-pool-mode work and it diverged for a
  while before being discovered and merged (commit `190f804`). If a
  worktree gets created for future work, don't let it sit un-merged for
  long — check `git worktree list` at the start of a session before
  assuming a clean slate.
