import { and, eq, ilike } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppDb } from '../db/client.js';
import { withRequestTenant } from '../db/request-tx.js';
import { characters, items, phaseItems, players, submissionEntries, submissions, phases } from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError, notFound, sendError } from '../errors.js';

const zCreatePhase = z.object({
  key: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  gameVersion: z.string().min(1),
});
const zPatchPhase = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(['DRAFT', 'OPEN', 'LOCKED', 'ARCHIVED']).optional(),
  submissionsCloseAt: z.string().datetime().nullable().optional(),
});
const zUnlockRequest = z.object({ reason: z.string().min(3).max(500) });

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
    await withRequestTenant(db, request, (tx) =>
      tx.insert(phases).values({ id, guildId, key: body.data.key, name: body.data.name, gameVersion: body.data.gameVersion, status: 'DRAFT' }),
    );
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
          .select({ itemId: items.itemId, name: items.name, quality: items.quality, slot: items.slot, source: items.source })
          .from(phaseItems)
          .innerJoin(items, eq(items.itemId, phaseItems.itemId))
          .where(and(...conditions))
          .limit(300);
        return { items: rows };
      });
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
};

export default phasesRoutes;
