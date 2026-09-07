import { and, eq, ilike, or } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { computeCapacity, validateSubmission, type CatalogItem, type ReservedCharacter } from '@glps/core';
import { zPutSubmissionRequest } from '@glps/contracts';
import type { AppDb, AppTx } from '../db/client.js';
import { withRequestTenant } from '../db/request-tx.js';
import { characters, guildSettings, items, phaseItems, phases, players, submissionEntries, submissions } from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError, notFound, sendError } from '../errors.js';
import { mergeSettings, type EffectiveSettings } from '../services/phase-settings.js';
import { fetchItemFromWowhead, searchWowheadByName } from '../services/wowhead-item.js';

async function loadPlayerContext(tx: AppTx, playerId: string) {
  const [player] = await tx.select().from(players).where(eq(players.id, playerId));
  if (!player) return null;
  const [phase] = await tx.select().from(phases).where(eq(phases.id, player.phaseId));
  const [settings] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, player.guildId));
  const [submission] = await tx.select().from(submissions).where(eq(submissions.playerId, playerId));
  const chars = await tx.select().from(characters).where(eq(characters.playerId, playerId));
  return { player, phase, settings, submission, characters: chars };
}

function phaseIsOpen(phase: { status: string; submissionsCloseAt: Date | null }): boolean {
  if (phase.status !== 'OPEN') return false;
  if (phase.submissionsCloseAt && phase.submissionsCloseAt.getTime() < Date.now()) return false;
  return true;
}

async function catalogLookup(tx: AppTx, phaseId: string, mode: string): Promise<(itemId: number) => CatalogItem | undefined> {
  const rows =
    mode === 'OPEN'
      ? await tx.select({ itemId: items.itemId, inventoryType: items.inventoryType, classMask: items.classMask }).from(items)
      : await tx
          .select({ itemId: items.itemId, inventoryType: items.inventoryType, classMask: items.classMask })
          .from(phaseItems)
          .innerJoin(items, eq(items.itemId, phaseItems.itemId))
          .where(and(eq(phaseItems.phaseId, phaseId), eq(phaseItems.enabled, true)));
  const byId = new Map(rows.map((r) => [r.itemId, { itemId: r.itemId, inventoryType: r.inventoryType as CatalogItem['inventoryType'], classMask: r.classMask ?? undefined }]));
  return (itemId: number) => byId.get(itemId);
}

async function ensureOpenModeItemsExist(tx: AppTx, entries: Array<{ itemId: number }>, gameVersion: string): Promise<void> {
  const distinctIds = [...new Set(entries.map((e) => e.itemId))];
  for (const itemId of distinctIds) {
    const [existing] = await tx.select({ itemId: items.itemId }).from(items).where(eq(items.itemId, itemId));
    if (existing) continue;
    try {
      const fetched = await fetchItemFromWowhead(itemId, gameVersion);
      await tx
        .insert(items)
        .values({ itemId: fetched.itemId, name: fetched.name, quality: fetched.quality, slot: fetched.slot, inventoryType: fetched.inventoryType, icon: fetched.icon })
        .onConflictDoUpdate({ target: items.itemId, set: { name: fetched.name, quality: fetched.quality, slot: fetched.slot, inventoryType: fetched.inventoryType, icon: fetched.icon } });
    } catch {
      // Fetch failed — leave this item absent from `items`. catalogLookup
      // will return undefined for it, and validateSubmission's existing
      // ITEM_NOT_IN_PHASE error covers it. No special-casing needed here.
    }
  }
}

const submissionsRoutes: FastifyPluginAsync<{ db: AppDb }> = async (fastify, { db }) => {
  fastify.get('/me', { config: { tenant: 'player' } }, async (request, reply) => {
    const { playerId } = request.principal as { type: 'PLAYER'; playerId: string };
    const ctx = await withRequestTenant(db, request, (tx) => loadPlayerContext(tx, playerId));
    if (!ctx?.player) return sendError(reply, notFound());
    return {
      player: { id: ctx.player.id, displayName: ctx.player.displayName, discordTag: ctx.player.discordTag },
      characters: ctx.characters,
      submissionStatus: ctx.submission?.status ?? 'DRAFT',
      phase: ctx.phase
        ? {
            key: ctx.phase.key,
            name: ctx.phase.name,
            status: ctx.phase.status,
            submissionsCloseAt: ctx.phase.submissionsCloseAt,
            open: phaseIsOpen(ctx.phase),
            itemPoolMode: ctx.phase.itemPoolMode,
          }
        : null,
      // Enough of guild_settings for the client to run @glps/core's computeCapacity
      // and validateSubmission live (§10) — never the full admin settings object.
      settings: ctx.settings
        ? mergeSettings(
            {
              listSize: ctx.settings.listSize,
              twohandConsumesOffhand: ctx.settings.twohandConsumesOffhand,
              allowAltOffspecInOffList: ctx.settings.allowAltOffspecInOffList,
              requireFullList: ctx.settings.requireFullList,
            },
            (ctx.phase?.settingsOverride as Partial<EffectiveSettings> | null) ?? null,
          )
        : null,
    };
  });

  fastify.get('/me/submission', { config: { tenant: 'player' } }, async (request, reply) => {
    const { playerId } = request.principal as { type: 'PLAYER'; playerId: string };
    const result = await withRequestTenant(db, request, async (tx) => {
      const ctx = await loadPlayerContext(tx, playerId);
      if (!ctx?.submission) return null;
      const entries = await tx.select().from(submissionEntries).where(eq(submissionEntries.submissionId, ctx.submission.id));
      const lookup = await catalogLookup(tx, ctx.player.phaseId, ctx.phase!.itemPoolMode);
      const capacitySettings = { listSize: ctx.settings!.listSize, twohandConsumesOffhand: ctx.settings!.twohandConsumesOffhand };
      const asEntryInputs = entries.map((e) => ({
        characterId: e.characterId,
        list: e.list as 'MAIN' | 'OFF',
        rank: e.rank,
        slot: e.slot as never,
        itemId: e.itemId,
        spec: e.spec,
      }));
      return {
        status: ctx.submission.status,
        version: ctx.submission.version,
        entries,
        capacity: {
          main: computeCapacity(asEntryInputs, 'MAIN', capacitySettings, (id) => lookup(id)?.inventoryType ?? 'HEAD'),
          off: computeCapacity(asEntryInputs, 'OFF', capacitySettings, (id) => lookup(id)?.inventoryType ?? 'HEAD'),
        },
      };
    });
    if (!result) return sendError(reply, notFound());
    return result;
  });

  fastify.put('/me/submission', { config: { tenant: 'player' } }, async (request, reply) => {
    const { playerId } = request.principal as { type: 'PLAYER'; playerId: string };
    const body = zPutSubmissionRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid submission payload.', body.error.flatten()));

    try {
      const result = await withRequestTenant(db, request, async (tx) => {
        const ctx = await loadPlayerContext(tx, playerId);
        if (!ctx?.submission || !ctx.phase || !ctx.settings) throw notFound('Submission not found.');
        if (ctx.submission.status === 'SUBMITTED') throw new ApiError(409, 'SUBMISSION_LOCKED', 'This submission is already locked.');

        if (ctx.phase.itemPoolMode === 'OPEN') {
          await ensureOpenModeItemsExist(tx, body.data.entries, ctx.phase.gameVersion);
        }

        const lookup = await catalogLookup(tx, ctx.player.phaseId, ctx.phase.itemPoolMode);
        const reserved: ReservedCharacter[] = ctx.characters.map((c) => ({
          characterId: c.id,
          slotIndex: c.slotIndex as 1 | 2,
          mainSpec: c.mainSpec,
          offSpec: c.offSpec ?? undefined,
        }));

        const validation = validateSubmission(body.data.entries as never, {
          settings: mergeSettings(
            {
              listSize: ctx.settings.listSize,
              twohandConsumesOffhand: ctx.settings.twohandConsumesOffhand,
              allowAltOffspecInOffList: ctx.settings.allowAltOffspecInOffList,
              requireFullList: ctx.settings.requireFullList,
            },
            ctx.phase.settingsOverride as Partial<EffectiveSettings> | null,
          ),
          reservedCharacters: reserved,
          lookupItem: lookup,
          submissionStatus: ctx.submission.status as 'DRAFT' | 'SUBMITTED',
          phaseOpen: phaseIsOpen(ctx.phase),
        });
        if (!validation.valid) {
          throw new ApiError(422, 'VALIDATION_FAILED', 'Submission has blocking errors.', validation);
        }

        await tx.delete(submissionEntries).where(eq(submissionEntries.submissionId, ctx.submission.id));
        if (body.data.entries.length > 0) {
          await tx.insert(submissionEntries).values(
            body.data.entries.map((e) => ({
              id: uuidv7(),
              guildId: ctx.player.guildId,
              submissionId: ctx.submission!.id,
              characterId: e.characterId,
              list: e.list,
              rank: e.rank,
              slot: e.slot,
              itemId: e.itemId,
              spec: e.spec,
              note: e.note ?? null,
            })),
          );
        }
        return { warnings: validation.warnings };
      });
      return result;
    } catch (err) {
      if (err instanceof ApiError) return sendError(reply, err);
      throw err;
    }
  });

  fastify.post('/me/submission/submit', { config: { tenant: 'player' } }, async (request, reply) => {
    const { playerId } = request.principal as { type: 'PLAYER'; playerId: string };
    try {
      const result = await withRequestTenant(db, request, async (tx) => {
        const ctx = await loadPlayerContext(tx, playerId);
        if (!ctx?.submission || !ctx.phase || !ctx.settings) throw notFound('Submission not found.');
        if (ctx.submission.status === 'SUBMITTED') {
          throw new ApiError(409, 'SUBMISSION_LOCKED', 'This submission has already been submitted and is immutable.');
        }

        const entries = await tx.select().from(submissionEntries).where(eq(submissionEntries.submissionId, ctx.submission.id));
        if (ctx.phase.itemPoolMode === 'OPEN') {
          await ensureOpenModeItemsExist(tx, entries, ctx.phase.gameVersion);
        }
        const lookup = await catalogLookup(tx, ctx.player.phaseId, ctx.phase.itemPoolMode);
        const reserved: ReservedCharacter[] = ctx.characters.map((c) => ({
          characterId: c.id,
          slotIndex: c.slotIndex as 1 | 2,
          mainSpec: c.mainSpec,
          offSpec: c.offSpec ?? undefined,
        }));
        const validation = validateSubmission(
          entries.map((e) => ({ characterId: e.characterId, list: e.list as 'MAIN' | 'OFF', rank: e.rank, slot: e.slot as never, itemId: e.itemId, spec: e.spec })),
          {
            settings: mergeSettings(
              {
                listSize: ctx.settings.listSize,
                twohandConsumesOffhand: ctx.settings.twohandConsumesOffhand,
                allowAltOffspecInOffList: ctx.settings.allowAltOffspecInOffList,
                requireFullList: ctx.settings.requireFullList,
              },
              ctx.phase.settingsOverride as Partial<EffectiveSettings> | null,
            ),
            reservedCharacters: reserved,
            lookupItem: lookup,
            submissionStatus: 'DRAFT',
            phaseOpen: phaseIsOpen(ctx.phase),
          },
        );
        if (!validation.valid) throw new ApiError(422, 'VALIDATION_FAILED', 'Cannot submit: blocking errors remain.', validation);

        const submittedAt = new Date();
        await tx
          .update(submissions)
          .set({ status: 'SUBMITTED', submittedAt, version: ctx.submission.version + 1 })
          .where(eq(submissions.id, ctx.submission.id));
        return { status: 'SUBMITTED' as const, submittedAt };
      });
      return result;
    } catch (err) {
      if (err instanceof ApiError) return sendError(reply, err);
      throw err;
    }
  });

  fastify.get<{ Querystring: { slot?: string; q?: string } }>('/me/items', { config: { tenant: 'player' } }, async (request) => {
    const { playerId } = request.principal as { type: 'PLAYER'; playerId: string };
    return withRequestTenant(db, request, async (tx) => {
      const [player] = await tx.select().from(players).where(eq(players.id, playerId));
      if (!player) return { items: [] };
      const conditions = [eq(phaseItems.phaseId, player.phaseId), eq(phaseItems.enabled, true)];
      if (request.query.slot) conditions.push(eq(items.slot, request.query.slot));
      if (request.query.q) conditions.push(or(ilike(items.name, `%${request.query.q}%`))!);
      const rows = await tx
        .select({
          itemId: items.itemId,
          name: items.name,
          quality: items.quality,
          slot: items.slot,
          inventoryType: items.inventoryType,
          icon: items.icon,
          source: items.source,
          classMask: items.classMask,
        })
        .from(phaseItems)
        .innerJoin(items, eq(items.itemId, phaseItems.itemId))
        .where(and(...conditions))
        .limit(300);
      return { items: rows };
    });
  });

  fastify.get<{ Params: { itemId: string } }>('/me/items/:itemId/preview', { config: { tenant: 'player' } }, async (request, reply) => {
    const { playerId } = request.principal as { type: 'PLAYER'; playerId: string };
    const itemId = Number(request.params.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid item ID.'));
    }
    const phase = await withRequestTenant(db, request, async (tx) => {
      const [player] = await tx.select().from(players).where(eq(players.id, playerId));
      if (!player) return null;
      const [phase] = await tx.select().from(phases).where(eq(phases.id, player.phaseId));
      return phase ?? null;
    });
    if (!phase) return sendError(reply, notFound());
    try {
      const item = await fetchItemFromWowhead(itemId, phase.gameVersion);
      return item;
    } catch (err) {
      if (err instanceof ApiError) return sendError(reply, err);
      throw err;
    }
  });

  fastify.get<{ Querystring: { q?: string } }>('/me/items/search', { config: { tenant: 'player' } }, async (request, reply) => {
    const { playerId } = request.principal as { type: 'PLAYER'; playerId: string };
    const q = request.query.q?.trim();
    if (!q || q.length < 2) {
      return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Search query must be at least 2 characters.'));
    }
    const phase = await withRequestTenant(db, request, async (tx) => {
      const [player] = await tx.select().from(players).where(eq(players.id, playerId));
      if (!player) return null;
      const [phase] = await tx.select().from(phases).where(eq(phases.id, player.phaseId));
      return phase ?? null;
    });
    if (!phase) return sendError(reply, notFound());
    try {
      const items = await searchWowheadByName(q, phase.gameVersion);
      return { items };
    } catch (err) {
      if (err instanceof ApiError) return sendError(reply, err);
      throw err;
    }
  });
};

export default submissionsRoutes;
