import type { AddonExport } from '@glps/contracts';

function luaString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function luaValue(v: unknown, indent: string): string {
  if (typeof v === 'string') return luaString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === undefined || v === null) return 'nil';
  if (Array.isArray(v)) return luaArray(v, indent);
  if (typeof v === 'object') return luaTable(v as Record<string, unknown>, indent);
  throw new Error(`Cannot serialize value of type ${typeof v} to Lua.`);
}

function luaArray(arr: unknown[], indent: string): string {
  if (arr.length === 0) return '{}';
  const inner = indent + '  ';
  const rows = arr.map((v) => `${inner}${luaValue(v, inner)},`).join('\n');
  return `{\n${rows}\n${indent}}`;
}

/** Object keys are emitted in insertion order — callers must pass pre-sorted objects for determinism. */
function luaTable(obj: Record<string, unknown>, indent: string): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const inner = indent + '  ';
  const rows = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${inner}${k} = ${luaValue(obj[k], inner)},`)
    .join('\n');
  return `{\n${rows}\n${indent}}`;
}

/** Numeric-string keys (item IDs) become Lua's `[19019] = {...}`, not `["19019"] = {...}`. */
function luaIndexedTable(obj: Record<string, unknown>, indent: string): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const inner = indent + '  ';
  const rows = keys
    .map((k) => {
      const isNumeric = /^\d+$/.test(k);
      const keyExpr = isNumeric ? `[${k}]` : `[${luaString(k)}]`;
      return `${inner}${keyExpr} = ${luaValue(obj[k], inner)},`;
    })
    .join('\n');
  return `{\n${rows}\n${indent}}`;
}

export function serializeAddonExportToLua(tree: AddonExport, phaseKey: string): string {
  const playersTable = luaIndexedTable(
    Object.fromEntries(Object.entries(tree.players).map(([name, p]) => [name, { ...p }])),
    '  ',
  );
  const itemsTable = luaIndexedTable(tree.items, '  ');
  const tokensTable = tree.tokens ? luaIndexedTable(tree.tokens, '  ') : undefined;
  const awardedArray = luaArray(
    tree.awarded.map((a) => ({ item: a.item, c: a.c, at: a.at, win: a.win, why: a.why, det: a.det })),
    '  ',
  );
  const bisCountsTable = luaIndexedTable(tree.bisCounts, '  ');

  const lines = [
    'GLPS_DB = {',
    `  schema = ${tree.schema},`,
    `  guild = ${luaString(tree.guild)},`,
    `  guildId = ${luaString(tree.guildId)},`,
    `  phase = ${luaString(phaseKey)},`,
    `  generatedAt = ${tree.generatedAt},`,
    `  checksum = ${luaString(tree.checksum)},`,
    `  players = ${playersTable},`,
    `  items = ${itemsTable},`,
    ...(tokensTable ? [`  tokens = ${tokensTable},`] : []),
    `  awarded = ${awardedArray},`,
    `  bisCounts = ${bisCountsTable},`,
    `  config = ${luaTable(tree.config as Record<string, unknown>, '  ')},`,
    '}',
    '',
  ];
  return lines.join('\n');
}
