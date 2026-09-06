import { describe, expect, it } from 'vitest';
import { signAdminAccessToken, signInstanceAccessToken, verifyInstanceAdminJwt } from '../src/services/jwt.js';

const SECRET = 'test-secret';

describe('instance-admin JWT (§ instance-admin guild registration)', () => {
  it('signs and verifies a valid instance-admin token', async () => {
    const token = await signInstanceAccessToken({ sub: 'admin-id-1' }, SECRET);
    const claims = await verifyInstanceAdminJwt(token, SECRET);
    expect(claims).toEqual({ sub: 'admin-id-1' });
  });

  it('rejects a guild-admin token presented as an instance-admin token', async () => {
    const guildAdminToken = await signAdminAccessToken({ sub: 'a1', gid: 'g1', role: 'LOOT_MASTER' }, SECRET);
    await expect(verifyInstanceAdminJwt(guildAdminToken, SECRET)).rejects.toThrow();
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = await signInstanceAccessToken({ sub: 'admin-id-1' }, SECRET);
    await expect(verifyInstanceAdminJwt(token, 'wrong-secret')).rejects.toThrow();
  });
});
