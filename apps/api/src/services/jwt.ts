import { jwtVerify, SignJWT } from 'jose';

export interface AdminJwtClaims {
  sub: string; // admin id
  gid: string; // guild id — the ONLY source of tenant identity for admin requests (§7)
  role: 'LOOT_MASTER' | 'OFFICER' | 'VIEWER';
}

function key(secret: string) {
  return new TextEncoder().encode(secret);
}

/** Short-lived (15 min) access token, per §7.1. */
export async function signAdminAccessToken(claims: AdminJwtClaims, secret: string): Promise<string> {
  return new SignJWT({ gid: claims.gid, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key(secret));
}

/** Rotating refresh token (7 days), per §7.1. */
export async function signAdminRefreshToken(claims: AdminJwtClaims, secret: string): Promise<string> {
  return new SignJWT({ gid: claims.gid, role: claims.role, typ: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(key(secret));
}

export async function verifyAdminJwt(token: string, secret: string): Promise<AdminJwtClaims> {
  const { payload } = await jwtVerify(token, key(secret));
  if (typeof payload.sub !== 'string' || typeof payload.gid !== 'string' || typeof payload.role !== 'string') {
    throw new Error('Malformed admin JWT payload.');
  }
  return { sub: payload.sub, gid: payload.gid, role: payload.role as AdminJwtClaims['role'] };
}
