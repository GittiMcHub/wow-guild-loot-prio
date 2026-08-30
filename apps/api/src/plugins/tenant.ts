import { sql as rawSql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { AppDb } from '../db/client.js';
import { unauthorized } from '../errors.js';
import { verifyAdminJwt } from '../services/jwt.js';
import { hashToken } from '../services/tokens.js';

export type TenantMode = 'public' | 'instance' | 'invite' | 'player' | 'admin';

export interface TenantContext {
  guildId: string;
}

export type Principal =
  | { type: 'ADMIN'; adminId: string; role: 'LOOT_MASTER' | 'OFFICER' | 'VIEWER' }
  | { type: 'PLAYER'; playerId: string; accessTokenId: string }
  | { type: 'INVITE'; inviteId: string; phaseId: string };

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: TenantContext;
    principal?: Principal;
  }
  interface FastifyContextConfig {
    /**
     * Which principal this route accepts. Required on every route — there is
     * no default — so a new endpoint can never silently skip tenant
     * resolution (§3A.6's "Standing rule for every milestone").
     */
    tenant: TenantMode;
  }
}

export interface TenantPluginOptions {
  db: AppDb;
  jwtSecret: string;
  tokenPepper: string;
}

interface InviteRow {
  invite_id: string;
  guild_id: string;
  phase_id: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  revoked_at: string | null;
}

interface PlayerTokenRow {
  access_token_id: string;
  guild_id: string;
  player_id: string;
  revoked_at: string | null;
}

/**
 * Resolves the tenant from exactly one of three principals (§3A.2): an
 * invite token in the URL, a player bearer token, or the admin JWT's `gid`
 * claim. No handler may read a guild id from the request body, query
 * string, or path — this hook is the only place tenant identity is decided.
 */
const tenantPlugin: FastifyPluginAsync<TenantPluginOptions> = async (fastify, opts) => {
  fastify.addHook('onRequest', async (request) => {
    const mode = request.routeOptions.config.tenant;
    if (mode === 'public' || mode === 'instance') return;

    if (mode === 'invite') {
      const token = (request.params as Record<string, string> | undefined)?.token;
      if (!token) throw unauthorized('Missing invite token.');
      const hash = hashToken(token, opts.tokenPepper);
      const rows = (await opts.db.execute(
        rawSql`SELECT * FROM resolve_invite_by_token_hash(${hash})`,
      )) as unknown as InviteRow[];
      const row = rows[0];
      if (!row?.invite_id) throw unauthorized('Invalid invite token.');
      if (row.revoked_at) throw unauthorized('This invite has been revoked.');
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        throw unauthorized('This invite has expired.');
      }
      if (row.used_count >= row.max_uses) throw unauthorized('This invite has already been used.');
      request.tenant = { guildId: row.guild_id };
      request.principal = { type: 'INVITE', inviteId: row.invite_id, phaseId: row.phase_id };
      return;
    }

    if (mode === 'player') {
      const auth = request.headers.authorization;
      const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
      if (!token) throw unauthorized('Missing player access token.');
      const hash = hashToken(token, opts.tokenPepper);
      const rows = (await opts.db.execute(
        rawSql`SELECT * FROM resolve_player_token_hash(${hash})`,
      )) as unknown as PlayerTokenRow[];
      const row = rows[0];
      if (!row?.access_token_id) throw unauthorized('Invalid access token.');
      if (row.revoked_at) throw unauthorized('This access token has been revoked.');
      request.tenant = { guildId: row.guild_id };
      request.principal = { type: 'PLAYER', playerId: row.player_id, accessTokenId: row.access_token_id };
      await opts.db.execute(rawSql`SELECT touch_access_token(${row.access_token_id}::uuid)`);
      return;
    }

    // mode === 'admin'
    const token = request.cookies?.glps_admin_at;
    if (!token) throw unauthorized('Missing admin session.');
    try {
      const claims = await verifyAdminJwt(token, opts.jwtSecret);
      request.tenant = { guildId: claims.gid };
      request.principal = { type: 'ADMIN', adminId: claims.sub, role: claims.role };
    } catch {
      throw unauthorized('Invalid or expired admin session.');
    }
  });
};

export default fp(tenantPlugin, { name: 'tenant' });
