export interface EffectiveSettings {
  listSize: number;
  twohandConsumesOffhand: boolean;
  allowAltOffspecInOffList: boolean;
  requireFullList: boolean;
}

/** Player-facing-only addition to EffectiveSettings — not consumed by
 * @glps/core's computeCapacity/validateSubmission, only by the client UI
 * (which end of the ladder owned items pin to). Kept separate from
 * EffectiveSettings so the validateSubmission call sites, which build a
 * narrower object, don't need to thread a field they never use. */
export interface PlayerFacingSettings extends EffectiveSettings {
  ownedItemsPriority: 'TOP' | 'BOTTOM';
}

export function mergeSettings<T extends object>(guildSettings: T, override: Partial<T> | null): T {
  return { ...guildSettings, ...(override ?? {}) };
}
