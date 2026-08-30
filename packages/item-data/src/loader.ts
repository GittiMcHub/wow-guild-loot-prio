import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CatalogItem, validateCatalog } from './schema.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** No image may require network access at runtime (§5) — catalogs ship inside the image. */
export function listCatalogs(): Array<{ gameVersion: string; phaseKey: string }> {
  const out: Array<{ gameVersion: string; phaseKey: string }> = [];
  for (const gameVersion of readdirSync(PACKAGE_ROOT, { withFileTypes: true })) {
    if (!gameVersion.isDirectory()) continue;
    const dir = join(PACKAGE_ROOT, gameVersion.name);
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.json')) {
        out.push({ gameVersion: gameVersion.name, phaseKey: file.replace(/\.json$/, '') });
      }
    }
  }
  return out;
}

export function loadCatalog(gameVersion: string, phaseKey: string): CatalogItem[] {
  const path = join(PACKAGE_ROOT, gameVersion, `${phaseKey}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return validateCatalog(raw);
}
