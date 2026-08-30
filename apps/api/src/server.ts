import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { fastify } = await buildApp(config);

try {
  await fastify.listen({ host: '0.0.0.0', port: config.port });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
