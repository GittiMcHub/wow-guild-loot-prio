import { type CatalogItem, zCatalogItem } from './schema.js';

/** Minimal RFC4180-ish line splitter: handles quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

/**
 * Parses `pnpm run catalog:import <file.csv>` input (§12). Expected header:
 * itemId,name,quality,slot,inventoryType,icon,source,classMask
 * (icon, source, classMask may be left empty.)
 */
export function parseCatalogCsv(csv: string): CatalogItem[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const required = ['itemid', 'name', 'quality', 'slot', 'inventorytype'];
  for (const col of required) {
    if (!header.includes(col)) {
      throw new Error(`CSV is missing required column "${col}". Header: ${lines[0]}`);
    }
  }

  const items: CatalogItem[] = [];
  for (let row = 1; row < lines.length; row++) {
    const fields = splitCsvLine(lines[row]!);
    const byColumn = Object.fromEntries(header.map((col, i) => [col, fields[i] ?? '']));
    const raw = {
      itemId: Number(byColumn.itemid),
      name: byColumn.name,
      quality: Number(byColumn.quality),
      slot: byColumn.slot,
      inventoryType: byColumn.inventorytype,
      icon: byColumn.icon || null,
      source: byColumn.source || null,
      classMask: byColumn.classmask ? Number(byColumn.classmask) : null,
    };
    const parsed = zCatalogItem.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Row ${row + 1} of CSV is invalid: ${parsed.error.message}`);
    }
    items.push(parsed.data);
  }
  return items;
}
