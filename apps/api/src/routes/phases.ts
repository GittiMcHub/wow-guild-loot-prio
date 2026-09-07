import { and, eq, ilike } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { encodeImportString } from '@glps/core/codec';
import type { AppDb } from '../db/client.js';
import { withRequestTenant } from '../db/request-tx.js';
import { characters, items, phaseItems, players, submissionEntries, submissions, phases } from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError, notFound, sendError } from '../errors.js';
import { buildAddonExport } from '../services/addon-export.js';
import { serializeAddonExportToLua } from '../services/lua-serializer.js';
import { fetchItemFromWowhead, fetchWowheadItemBasic } from '../services/wowhead-item.js';

const zCreatePhase = z.object({
  name: z.string().min(1).max(120),
  gameVersion: z.string().min(1),
});
const zPatchPhase = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(['DRAFT', 'OPEN', 'LOCKED', 'ARCHIVED']).optional(),
  submissionsCloseAt: z.string().datetime().nullable().optional(),
  itemPoolMode: z.enum(['PREDEFINED', 'OPEN']).optional(),
  settingsOverride: z
    .object({
      listSize: z.number().int().min(1).max(40),
      twohandConsumesOffhand: z.boolean(),
      allowAltOffspecInOffList: z.boolean(),
      requireFullList: z.boolean(),
      ownedItemsPriority: z.enum(['TOP', 'BOTTOM']),
    })
    .partial()
    .nullable()
    .optional(),
});

/** Lowercase, non-alphanumeric -> '-', trimmed, capped — for the auto-generated phase key (§ no more manual Key field). */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return base || 'phase';
}
const zUnlockRequest = z.object({ reason: z.string().min(3).max(500) });
const zAttachItem = z.object({
  itemId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  quality: z.number().int().min(0).max(7),
  slot: z.string().min(1),
  inventoryType: z.enum(['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER', 'TRINKET', 'ONEHAND', 'TWOHAND', 'OFFHAND', 'SHIELD', 'RANGED', 'RELIC']),
  icon: z.string().nullable(),
  // Set when this item isn't itself what drops — e.g. a tier token or a
  // quest item produces it instead. Omitted/null clears any existing
  // mapping (§ token/quest-item acquisition design).
  acquiredVia: z
    .object({ itemId: z.number().int().positive(), name: z.string().min(1).max(200), icon: z.string().nullable() })
    .nullable()
    .optional(),
});

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['OPEN'],
  OPEN: ['LOCKED'],
  LOCKED: ['ARCHIVED', 'OPEN'],
  ARCHIVED: [],
};

const phasesRoutes: FastifyPluginAsync<{ db: AppDb }> = async (fastify, { db }) => {
  fastify.get('/phases', { config: { tenant: 'admin' } }, async (request) => {
    const rows = await withRequestTenant(db, request, (tx) => tx.select().from(phases));
    return { phases: rows };
  });

  fastify.post('/phases', { config: { tenant: 'admin' } }, async (request, reply) => {
    const body = zCreatePhase.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid phase payload.', body.error.flatten()));
    const guildId = request.tenant!.guildId;
    const id = uuidv7();
    try {
      await withRequestTenant(db, request, async (tx) => {
        const base = slugify(body.data.name);
        const existing = await tx.select({ key: phases.key }).from(phases).where(and(eq(phases.guildId, guildId), ilike(phases.key, `${base}%`)));
        const taken = new Set(existing.map((r) => r.key));
        let key = base;
        let n = 2;
        while (taken.has(key)) key = `${base}-${n++}`;
        await tx.insert(phases).values({ id, guildId, key, name: body.data.name, gameVersion: body.data.gameVersion, status: 'DRAFT' });
      });
    } catch (err) {
      // TOCTOU: two concurrent creates deriving the same key from the same
      // name both pass the pre-check. Rare (admin-only, low concurrency) —
      // ask the requester to retry rather than silently renaming for them.
      if ((err as { code?: string }).code === '23505') {
        return sendError(reply, new ApiError(409, 'VALIDATION_FAILED', 'A phase with that name was just created — try again.'));
      }
      throw err;
    }
    return { id };
  });

  fastify.get<{ Params: { id: string } }>('/phases/:id', { config: { tenant: 'admin' } }, async (request, reply) => {
    const [phase] = await withRequestTenant(db, request, (tx) => tx.select().from(phases).where(eq(phases.id, request.params.id)));
    if (!phase) return sendError(reply, notFound());
    return phase;
  });

  fastify.patch<{ Params: { id: string } }>('/phases/:id', { config: { tenant: 'admin' } }, async (request, reply) => {
    const body = zPatchPhase.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid phase patch.', body.error.flatten()));

    try {
      const updated = await withRequestTenant(db, request, async (tx) => {
        const [phase] = await tx.select().from(phases).where(eq(phases.id, request.params.id));
        if (!phase) throw notFound();
        if (body.data.status && body.data.status !== phase.status) {
          const allowed = VALID_TRANSITIONS[phase.status] ?? [];
          if (!allowed.includes(body.data.status)) {
            throw new ApiError(409, 'VALIDATION_FAILED', `Cannot transition phase from ${phase.status} to ${body.data.status}.`);
          }
        }
        const [row] = await tx
          .update(phases)
          .set({
            ...(body.data.name !== undefined ? { name: body.data.name } : {}),
            ...(body.data.status !== undefined ? { status: body.data.status } : {}),
            ...(body.data.submissionsCloseAt !== undefined
              ? { submissionsCloseAt: body.data.submissionsCloseAt ? new Date(body.data.submissionsCloseAt) : null }
              : {}),
            ...(body.data.itemPoolMode !== undefined ? { itemPoolMode: body.data.itemPoolMode } : {}),
            ...(body.data.settingsOverride !== undefined ? { settingsOverride: body.data.settingsOverride } : {}),
          })
          .where(eq(phases.id, request.params.id))
          .returning();
        return row;
      });
      return updated;
    } catch (err) {
      if (err instanceof ApiError) return sendError(reply, err);
      throw err;
    }
  });

  fastify.get<{ Params: { id: string } }>('/phases/:id/submissions', { config: { tenant: 'admin' } }, async (request) => {
    return withRequestTenant(db, request, async (tx) => {
      const playerRows = await tx.select().from(players).where(eq(players.phaseId, request.params.id));
      const results = [];
      for (const player of playerRows) {
        const [submission] = await tx.select().from(submissions).where(eq(submissions.playerId, player.id));
        const chars = await tx.select().from(characters).where(eq(characters.playerId, player.id));
        const entryCount = submission
          ? (await tx.select().from(submissionEntries).where(eq(submissionEntries.submissionId, submission.id))).length
          : 0;
        results.push({
          playerId: player.id,
          displayName: player.displayName,
          characters: chars.map((c) => c.name),
          status: submission?.status ?? 'DRAFT',
          entryCount,
        });
      }
      return { submissions: results };
    });
  });

  fastify.get<{ Params: { id: string; playerId: string } }>(
    '/phases/:id/submissions/:playerId',
    { config: { tenant: 'admin' } },
    async (request, reply) => {
      const result = await withRequestTenant(db, request, async (tx) => {
        const [player] = await tx.select().from(players).where(eq(players.id, request.params.playerId));
        if (!player) return null;
        const [submission] = await tx.select().from(submissions).where(eq(submissions.playerId, player.id));
        const chars = await tx.select().from(characters).where(eq(characters.playerId, player.id));
        const entries = submission
          ? await tx.select().from(submissionEntries).where(eq(submissionEntries.submissionId, submission.id))
          : [];
        return { player, characters: chars, submission, entries };
      });
      if (!result) return sendError(reply, notFound());
      return result;
    },
  );

  fastify.post<{ Params: { id: string; playerId: string } }>(
    '/phases/:id/submissions/:playerId/unlock',
    { config: { tenant: 'admin' } },
    async (request, reply) => {
      const body = zUnlockRequest.safeParse(request.body);
      if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'A reason is required to unlock.', body.error.flatten()));
      const principal = request.principal as { type: 'ADMIN'; adminId: string };

      const result = await withRequestTenant(db, request, async (tx) => {
        const [submission] = await tx.select().from(submissions).where(eq(submissions.playerId, request.params.playerId));
        if (!submission) return null;
        const [row] = await tx
          .update(submissions)
          .set({ status: 'DRAFT', unlockedBy: principal.adminId, unlockReason: body.data.reason, version: submission.version + 1 })
          .where(eq(submissions.id, submission.id))
          .returning();
        return row;
      });
      if (!result) return sendError(reply, notFound());
      return result;
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/phases/:id/items',
    { config: { tenant: 'admin' } },
    async (request) => {
      return withRequestTenant(db, request, async (tx) => {
        const conditions = [eq(phaseItems.phaseId, request.params.id), eq(phaseItems.enabled, true)];
        if (request.query.q) conditions.push(ilike(items.name, `%${request.query.q}%`));
        const rows = await tx
          .select({
            itemId: items.itemId,
            name: items.name,
            quality: items.quality,
            slot: items.slot,
            source: items.source,
            acquiredViaItemId: items.acquiredViaItemId,
            acquiredViaName: items.acquiredViaName,
            acquiredViaIcon: items.acquiredViaIcon,
          })
          .from(phaseItems)
          .innerJoin(items, eq(items.itemId, phaseItems.itemId))
          .where(and(...conditions))
          .limit(300);
        return { items: rows };
      });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/phases/:id/items',
    { config: { tenant: 'admin' } },
    async (request, reply) => {
      const body = zAttachItem.safeParse(request.body);
      if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid item payload.', body.error.flatten()));
      const guildId = request.tenant!.guildId;

      const result = await withRequestTenant(db, request, async (tx) => {
        const [phase] = await tx.select().from(phases).where(eq(phases.id, request.params.id));
        if (!phase) return null;

        const acquiredVia = body.data.acquiredVia ?? null;
        await tx
          .insert(items)
          .values({
            itemId: body.data.itemId,
            name: body.data.name,
            quality: body.data.quality,
            slot: body.data.slot,
            inventoryType: body.data.inventoryType,
            icon: body.data.icon,
            acquiredViaItemId: acquiredVia?.itemId ?? null,
            acquiredViaName: acquiredVia?.name ?? null,
            acquiredViaIcon: acquiredVia?.icon ?? null,
          })
          .onConflictDoUpdate({
            target: items.itemId,
            set: {
              name: body.data.name,
              quality: body.data.quality,
              slot: body.data.slot,
              inventoryType: body.data.inventoryType,
              icon: body.data.icon,
              acquiredViaItemId: acquiredVia?.itemId ?? null,
              acquiredViaName: acquiredVia?.name ?? null,
              acquiredViaIcon: acquiredVia?.icon ?? null,
            },
          });
        await tx
          .insert(phaseItems)
          .values({ guildId, phaseId: request.params.id, itemId: body.data.itemId, enabled: true })
          .onConflictDoUpdate({
            target: [phaseItems.phaseId, phaseItems.itemId],
            set: { enabled: true },
          });
        return { ok: true };
      });
      if (!result) return sendError(reply, notFound());
      return result;
    },
  );

  fastify.delete<{ Params: { id: string; itemId: string } }>(
    '/phases/:id/items/:itemId',
    { config: { tenant: 'admin' } },
    async (request) => {
      await withRequestTenant(db, request, (tx) =>
        tx
          .update(phaseItems)
          .set({ enabled: false })
          .where(and(eq(phaseItems.phaseId, request.params.id), eq(phaseItems.itemId, Number(request.params.itemId)))),
      );
      return { ok: true };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/phases/:id/items/fetch',
    { config: { tenant: 'admin' } },
    async (request, reply) => {
      const body = z.object({ itemId: z.number().int().positive() }).safeParse(request.body);
      if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid item ID.', body.error.flatten()));

      const [phase] = await withRequestTenant(db, request, (tx) => tx.select().from(phases).where(eq(phases.id, request.params.id)));
      if (!phase) return sendError(reply, notFound());

      try {
        const item = await fetchItemFromWowhead(body.data.itemId, phase.gameVersion);
        return item;
      } catch (err) {
        if (err instanceof ApiError) return sendError(reply, err);
        throw err;
      }
    },
  );

  // Fetches a token/quest item's display data (§ token/quest-item
  // acquisition design) — deliberately does NOT require jsonequip, unlike
  // /items/fetch, since these are never equippable.
  fastify.post<{ Params: { id: string } }>(
    '/phases/:id/tokens/fetch',
    { config: { tenant: 'admin' } },
    async (request, reply) => {
      const body = z.object({ itemId: z.number().int().positive() }).safeParse(request.body);
      if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid item ID.', body.error.flatten()));

      const [phase] = await withRequestTenant(db, request, (tx) => tx.select().from(phases).where(eq(phases.id, request.params.id)));
      if (!phase) return sendError(reply, notFound());

      try {
        const item = await fetchWowheadItemBasic(body.data.itemId, phase.gameVersion);
        return item;
      } catch (err) {
        if (err instanceof ApiError) return sendError(reply, err);
        throw err;
      }
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: { view?: string } }>(
    '/phases/:id/matrix',
    { config: { tenant: 'admin' } },
    async (request) => {
      return withRequestTenant(db, request, async (tx) => {
        const rows = await tx
          .select({
            playerId: players.id,
            displayName: players.displayName,
            characterId: characters.id,
            characterName: characters.name,
            list: submissionEntries.list,
            rank: submissionEntries.rank,
            slot: submissionEntries.slot,
            itemId: submissionEntries.itemId,
            itemName: items.name,
            itemQuality: items.quality,
            fulfilledAt: submissionEntries.fulfilledAt,
          })
          .from(submissionEntries)
          .innerJoin(submissions, eq(submissions.id, submissionEntries.submissionId))
          .innerJoin(players, eq(players.id, submissions.playerId))
          .innerJoin(characters, eq(characters.id, submissionEntries.characterId))
          .innerJoin(items, eq(items.itemId, submissionEntries.itemId))
          .where(and(eq(submissions.phaseId, request.params.id), eq(submissions.status, 'SUBMITTED')));

        const view = request.query.view ?? 'slot';
        if (view === 'item') {
          const byItem = new Map<number, typeof rows>();
          for (const row of rows) {
            const list = byItem.get(row.itemId) ?? [];
            list.push(row);
            byItem.set(row.itemId, list);
          }
          return { view, items: Object.fromEntries(byItem) };
        }
        return { view, rows };
      });
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/phases/:id/export',
    { config: { tenant: 'admin' } },
    async (request, reply) => {
      const guildId = request.tenant!.guildId;
      const format = request.query.format === 'addon-json' ? 'addon-json' : 'addon-lua';

      const result = await withRequestTenant(db, request, async (tx) => {
        const [phase] = await tx.select().from(phases).where(eq(phases.id, request.params.id));
        if (!phase) return null;
        const tree = await buildAddonExport(tx, guildId, request.params.id);
        return { tree, phaseKey: phase.key };
      });
      if (!result) return sendError(reply, notFound());
      const { tree, phaseKey } = result;

      if (format === 'addon-json') {
        return { json: tree, importString: encodeImportString(tree) };
      }

      const lua = serializeAddonExportToLua(tree, phaseKey);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="GLPS_${phaseKey}_${stamp}.lua"`);
      return reply.send(lua);
    },
  );
};

export default phasesRoutes;
