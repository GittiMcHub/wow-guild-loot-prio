/**
 * Every guild-configurable knob from §15 lives in `guild_settings`, not here.
 * What's read from the environment is instance-wide: connection strings,
 * secrets, and the *defaults* applied when a new guild is provisioned
 * (§3A.5) — changing an env var never alters an existing guild.
 */
export interface AppConfig {
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  tokenPepper: string;
  publicBaseUrl: string;
  port: number;
  seedDemo: boolean;
}

function required(name: string, isProd: boolean, devDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProd) throw new Error(`${name} is required in production.`);
  return devDefault;
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProd = nodeEnv === 'production';
  return {
    nodeEnv,
    databaseUrl: required('DATABASE_URL_APP', isProd, 'postgres://glps_app:glps_app_dev@127.0.0.1:5432/glps'),
    jwtSecret: required('JWT_SECRET', isProd, 'dev-jwt-secret-change-me'),
    tokenPepper: required('TOKEN_PEPPER', isProd, 'dev-token-pepper-change-me'),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080',
    port: Number(process.env.PORT ?? 3000),
    seedDemo: process.env.SEED_DEMO === 'true',
  };
}
