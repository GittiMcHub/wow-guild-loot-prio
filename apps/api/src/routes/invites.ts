import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { zClaimInviteRequest, zCreateInvitesRequest } from '@glps/contracts';
import type { AppDb } from '../db/client.js';
import { withRequestTenant } from '../db/request-tx.js';
import { accessTokens, characters, invites, phases, players, submissions } from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError, notFound, sendError } from '../errors.js';
import { generatePlaintextToken, hashToken } from '../services/tokens.js';

const invitesRoutes: FastifyPluginAsync<{ db: AppDb; tokenPepper: string; publicBaseUrl: string }> = async (
  fastify,
  { db, tokenPepper, publicBaseUrl },
) => {
  // ---- Public: claim flow (tenant resolved from the invite token itself) ----

  fastify.get('/invites/:token', { config: { tenant: 'invite' } }, async (request, reply) => {
    const { phaseId, inviteId } = request.principal as { type: 'INVITE'; inviteId: string; phaseId: string };
    const result = await withRequestTenant(db, request, async (tx) => {
      const [phase] = await tx.select().from(phases).where(eq(phases.id, phaseId));
      const [invite] = await tx.select().from(invites).where(eq(invites.id, inviteId));
      return { phase, invite };
    });
    if (!result.phase || !result.invite) return sendError(reply, notFound());
    return {
      phase: { id: result.phase.id, key: result.phase.key, name: result.phase.name, status: result.phase.status },
      kind: result.invite.kind,
      prefill: result.invite.prefill,
      label: result.invite.label,
    };
  });

  fastify.post('/invites/:token/claim', { config: { tenant: 'invite' } }, async (request, reply) => {
    const { phaseId, inviteId } = request.principal as { type: 'INVITE'; inviteId: string; phaseId: string };
    const body = zClaimInviteRequest.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid claim payload.', body.error.flatten()));
    }

    const mains = body.data.characters.filter((c) => c.isMainCharacter);
    if (mains.length !== 1) {
      return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Exactly one character must be marked as the main character.'));
    }

    const guildId = request.tenant!.guildId;
    const plaintext = generatePlaintextToken();
    const tokenHash = hashToken(plaintext, tokenPepper);

    try {
      const playerId = await withRequestTenant(db, request, async (tx) => {
        const [invite] = await tx.select().from(invites).where(eq(invites.id, inviteId));
        if (!invite) throw notFound('Invite not found.');
        if (invite.revokedAt) throw new ApiError(410, 'INVITE_REVOKED', 'This invite has been revoked.');
        if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
          throw new ApiError(410, 'INVITE_EXPIRED', 'This invite has expired.');
        }
        if (invite.usedCount >= invite.maxUses) {
          throw new ApiError(410, 'INVITE_EXHAUSTED', 'This invite has already been used.');
        }

        const newPlayerId = uuidv7();
        await tx.insert(players).values({
          id: newPlayerId,
          guildId,
          phaseId,
          displayName: body.data.displayName,
          discordTag: body.data.discordTag,
        });

        for (const char of body.data.characters) {
          await tx.insert(characters).values({
            id: uuidv7(),
            guildId,
            playerId: newPlayerId,
            name: char.name,
            class: char.class,
            mainSpec: char.mainSpec,
            offSpec: char.offSpec,
            isMainCharacter: char.isMainCharacter,
            slotIndex: char.slotIndex,
          });
        }

        await tx.insert(submissions).values({
          id: uuidv7(),
          guildId,
          phaseId,
          playerId: newPlayerId,
          inviteId,
          status: 'DRAFT',
          version: 1,
        });

        await tx.insert(accessTokens).values({ id: uuidv7(), guildId, playerId: newPlayerId, tokenHash });
        await tx.update(invites).set({ usedCount: invite.usedCount + 1 }).where(eq(invites.id, inviteId));

        return newPlayerId;
      });

      return { playerToken: plaintext, playerId };
    } catch (err) {
      if (err instanceof ApiError) return sendError(reply, err);
      throw err;
    }
  });

  // ---- Admin: create / list / revoke ----

  fastify.post<{ Params: { id: string } }>('/phases/:id/invites', { config: { tenant: 'admin' } }, async (request, reply) => {
    const body = zCreateInvitesRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid invite request.', body.error.flatten()));
    const guildId = request.tenant!.guildId;
    const phaseId = request.params.id;
    const principal = request.principal as { type: 'ADMIN'; adminId: string };

    const inviteCount = body.data.kind === 'GENERIC' ? (body.data.count ?? 1) : 1;
    const created = await withRequestTenant(db, request, async (tx) => {
      const [phase] = await tx.select().from(phases).where(eq(phases.id, phaseId));
      if (!phase) throw notFound('Phase not found.');

      const rows: Array<{ id: string; token: string; label: string | null }> = [];
      for (let i = 0; i < inviteCount; i++) {
        const plaintext = generatePlaintextToken();
        const id = uuidv7();
        await tx.insert(invites).values({
          id,
          guildId,
          phaseId,
          tokenHash: hashToken(plaintext, tokenPepper),
          kind: body.data.kind,
          prefill: body.data.prefill ?? null,
          label: body.data.label ?? null,
          maxUses: body.data.maxUses ?? 1,
          expiresAt: body.data.expiresAt ? new Date(body.data.expiresAt) : null,
          createdBy: principal.adminId,
        });
        rows.push({ id, token: plaintext, label: body.data.label ?? null });
      }
      return rows;
    });

    return {
      invites: created.map((r) => ({ id: r.id, url: `${publicBaseUrl}/i/${r.token}`, label: r.label })),
    };
  });

  fastify.get<{ Params: { id: string } }>('/phases/:id/invites', { config: { tenant: 'admin' } }, async (request) => {
    const rows = await withRequestTenant(db, request, (tx) =>
      tx.select().from(invites).where(eq(invites.phaseId, request.params.id)),
    );
    return {
      invites: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        label: r.label,
        maxUses: r.maxUses,
        usedCount: r.usedCount,
        expiresAt: r.expiresAt,
        revokedAt: r.revokedAt,
        createdAt: r.createdAt,
      })),
    };
  });

  fastify.post<{ Params: { id: string } }>('/invites/:id/revoke', { config: { tenant: 'admin' } }, async (request, reply) => {
    const [updated] = await withRequestTenant(db, request, (tx) =>
      tx.update(invites).set({ revokedAt: new Date() }).where(eq(invites.id, request.params.id)).returning({ id: invites.id }),
    );
    if (!updated) return sendError(reply, notFound());
    return { ok: true };
  });
};

export default invitesRoutes;
