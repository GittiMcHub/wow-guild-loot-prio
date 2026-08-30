import { randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { explainDecision, resolveDrop, type ResolveOptions, type RollRecord } from '@glps/core';
import { zCreateAwardRequest, zCreateRollRequest, zResolveDropRequest } from '@glps/contracts';
import type { AppDb, AppTx } from '../db/client.js';
import { withRequestTenant } from '../db/request-tx.js';
import { attendance, awards, characters, guildSettings, rolls, submissionEntries } from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError, notFound, sendError } from '../errors.js';
import { computeBisCounts } from '../services/bis-count.js';
import { loadClaimsForItem } from '../services/claims.js';

async function loadResolveOptions(tx: AppTx, guildId: string, phaseId: string, raidSessionId?: string) {
  const [settings] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
  if (!settings) throw notFound('Guild settings not found.');
  const bisCounts = await computeBisCounts(
    tx,
    phaseId,
    {
      mode: settings.equalDistributionMode as 'OFF' | 'PHASE' | 'SESSION',
      scope: settings.bisCountScope as 'PLAYER' | 'CHARACTER',
      weightMain: Number(settings.bisCountWeightMain),
      weightOff: Number(settings.bisCountWeightOff),
      weightOverride: Number(settings.bisCountWeightOverride),
    },
    raidSessionId,
  );
  const options: ResolveOptions = {
    equalDistributionMode: settings.equalDistributionMode as ResolveOptions['equalDistributionMode'],
    bisCountScope: settings.bisCountScope as ResolveOptions['bisCountScope'],
    bisCounts,
  };
  return { options, weightOff: Number(settings.bisCountWeightOff) };
}

async function presentCharacterIdsFor(tx: AppTx, guildId: string, explicit?: string[], raidSessionId?: string): Promise<Set<string>> {
  if (explicit && explicit.length > 0) return new Set(explicit);
  if (raidSessionId) {
    const rows = await tx
      .select({ characterId: attendance.characterId })
      .from(attendance)
      .where(and(eq(attendance.raidSessionId, raidSessionId), eq(attendance.present, true)));
    if (rows.length > 0) return new Set(rows.map((r) => r.characterId));
  }
  return new Set(); // §2.6: empty = "no roster set" — resolver treats everyone as present.
}

const dropsRoutes: FastifyPluginAsync<{ db: AppDb }> = async (fastify, { db }) => {
  fastify.post<{ Params: { id: string } }>('/phases/:id/drops/resolve', { config: { tenant: 'admin' } }, async (request, reply) => {
    const body = zResolveDropRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid resolve request.', body.error.flatten()));
    const guildId = request.tenant!.guildId;
    const phaseId = request.params.id;

    const result = await withRequestTenant(db, request, async (tx) => {
      const { options } = await loadResolveOptions(tx, guildId, phaseId, body.data.raidSessionId);
      const claims = await loadClaimsForItem(tx, phaseId, body.data.itemId);
      const present = await presentCharacterIdsFor(tx, guildId, body.data.presentCharacterIds, body.data.raidSessionId);
      return resolveDrop(body.data.itemId, claims, present, options);
    });
    return result;
  });

  fastify.post<{ Params: { id: string } }>('/phases/:id/rolls', { config: { tenant: 'admin' } }, async (request, reply) => {
    const body = zCreateRollRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid roll request.', body.error.flatten()));
    const guildId = request.tenant!.guildId;

    const created = await withRequestTenant(db, request, async (tx) => {
      let results: RollRecord[];
      if (body.data.source === 'INGAME') {
        if (!body.data.results || body.data.results.length !== body.data.characterIds.length) {
          throw new ApiError(400, 'VALIDATION_FAILED', 'INGAME rolls require one result per characterId.');
        }
        const names = await tx.select().from(characters).where(eq(characters.guildId, guildId));
        const nameById = new Map(names.map((c) => [c.id, c.name]));
        results = body.data.results.map((r) => ({ characterId: r.characterId, characterName: nameById.get(r.characterId) ?? '?', value: r.value }));
      } else {
        const names = await tx.select().from(characters).where(eq(characters.guildId, guildId));
        const nameById = new Map(names.map((c) => [c.id, c.name]));
        let tied = body.data.characterIds;
        let attempt: RollRecord[] = [];
        // Automatic re-roll on an exact tie (§2.5), capped to stay finite.
        for (let round = 0; round < 20 && tied.length > 0; round++) {
          attempt = tied.map((characterId) => ({
            characterId,
            characterName: nameById.get(characterId) ?? '?',
            value: randomInt(1, 101),
          }));
          const best = Math.max(...attempt.map((r) => r.value));
          const stillTied = attempt.filter((r) => r.value === best);
          if (stillTied.length === 1 || tied.length === 1) break;
          tied = stillTied.map((r) => r.characterId);
        }
        results = attempt;
      }

      const id = uuidv7();
      await tx.insert(rolls).values({ id, guildId, itemId: body.data.itemId, source: body.data.source, results });
      return { id, itemId: body.data.itemId, source: body.data.source, results };
    });
    return created;
  });

  fastify.post<{ Params: { id: string } }>('/phases/:id/awards', { config: { tenant: 'admin' } }, async (request, reply) => {
    const body = zCreateAwardRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid award request.', body.error.flatten()));
    const guildId = request.tenant!.guildId;
    const phaseId = request.params.id;
    const principal = request.principal as { type: 'ADMIN'; adminId: string };

    try {
      const created = await withRequestTenant(db, request, async (tx) => {
        const { options, weightOff } = await loadResolveOptions(tx, guildId, phaseId);
        const claims = await loadClaimsForItem(tx, phaseId, body.data.itemId);
        const present = new Set(claims.map((c) => c.characterId));
        const result = resolveDrop(body.data.itemId, claims, present, options);

        let rollRecords: RollRecord[] = [];
        if (body.data.rollId) {
          const [rollRow] = await tx.select().from(rolls).where(eq(rolls.id, body.data.rollId));
          if (rollRow) rollRecords = rollRow.results as RollRecord[];
        }

        let entryId = body.data.entryId;
        let characterId = body.data.characterId;
        if (body.data.awardType === 'PRIORITY' && !characterId) {
          const winner = rollRecords.length > 0
            ? result.winnerGroup.find((c) => rollRecords.some((r) => r.characterId === c.characterId && r.value === Math.max(...rollRecords.map((x) => x.value))))
            : result.winnerGroup[0];
          characterId = winner?.characterId;
          entryId = entryId ?? winner?.entryId;
        }
        // entryId marks which listed wish is fulfilled (§2.7) — infer it from the resolved
        // claim for this character whenever the caller didn't supply one explicitly.
        if (body.data.awardType === 'PRIORITY' && !entryId && characterId) {
          entryId = result.ranked.find((c) => c.characterId === characterId && !c.excludedReason)?.entryId;
        }

        let characterName: string | undefined;
        if (characterId) {
          const [char] = await tx.select().from(characters).where(eq(characters.id, characterId));
          characterName = char?.name;
        }

        const explanation = explainDecision(
          result,
          {
            itemId: body.data.itemId,
            characterId,
            characterName,
            awardType: body.data.awardType,
            overrideReason: body.data.overrideReason,
            decidedAt: new Date().toISOString(),
          },
          rollRecords,
          { equalDistributionMode: options.equalDistributionMode, bisCountScope: options.bisCountScope, weightOff },
        );

        const id = uuidv7();
        await tx.insert(awards).values({
          id,
          guildId,
          phaseId,
          itemId: body.data.itemId,
          entryId: entryId ?? null,
          characterId: characterId ?? null,
          awardType: body.data.awardType,
          overrideReason: body.data.overrideReason ?? null,
          decidedBy: principal.adminId,
          winCondition: explanation.winCondition,
          explanation,
          snapshot: result,
        });

        if (entryId) {
          await tx.update(submissionEntries).set({ fulfilledAt: new Date(), fulfilledByAward: id }).where(eq(submissionEntries.id, entryId));
        }

        return { id, explanation };
      });
      return created;
    } catch (err) {
      if (err instanceof ApiError) return sendError(reply, err);
      throw err;
    }
  });

  fastify.post<{ Params: { id: string } }>('/awards/:id/revert', { config: { tenant: 'admin' } }, async (request, reply) => {
    const result = await withRequestTenant(db, request, async (tx) => {
      const [award] = await tx.select().from(awards).where(eq(awards.id, request.params.id));
      if (!award) return null;
      await tx.update(awards).set({ revertedAt: new Date() }).where(eq(awards.id, award.id));
      if (award.entryId) {
        await tx.update(submissionEntries).set({ fulfilledAt: null, fulfilledByAward: null }).where(eq(submissionEntries.id, award.entryId));
      }
      return { ok: true };
    });
    if (!result) return sendError(reply, notFound());
    return result;
  });
};

export default dropsRoutes;
