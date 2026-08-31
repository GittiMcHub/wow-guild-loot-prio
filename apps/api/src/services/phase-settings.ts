export interface EffectiveSettings {
  listSize: number;
  twohandConsumesOffhand: boolean;
  allowAltOffspecInOffList: boolean;
  requireFullList: boolean;
}

export function mergeSettings(guildSettings: EffectiveSettings, override: Partial<EffectiveSettings> | null): EffectiveSettings {
  return { ...guildSettings, ...(override ?? {}) };
}
