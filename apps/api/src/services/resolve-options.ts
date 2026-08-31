import { eq } from 'drizzle-orm';
import type { ResolveOptions } from '@glps/core';
import type { AppTx } from '../db/client.js';
import { guildSettings } from '../db/schema.js';
import { notFound } from '../errors.js';
import { computeBisCounts } from './bis-count.js';

export async function loadResolveOptions(
  tx: AppTx,
  guildId: string,
  phaseId: string,
  raidSessionId?: string,
): Promise<{ options: ResolveOptions; weightOff: number }> {
  const [settings] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
  if (!settings) throw notFound('Guild settings not found.');
  const bisCounts = await computeBisCounts(
    tx,
    phaseId,
    {
      mode: settings.equalDistributionMode as 'OFF' | 'PHASE' | 'SESSION',
      scope: settings.bisCountScope as 'PLAYER' | 'CHARACTER',
      weightMain: Number(settings.bisCountWeightMain),
      weightOff: Number(settings.bisCountWeightOff),
      weightOverride: Number(settings.bisCountWeightOverride),
    },
    raidSessionId,
  );
  const options: ResolveOptions = {
    equalDistributionMode: settings.equalDistributionMode as ResolveOptions['equalDistributionMode'],
    bisCountScope: settings.bisCountScope as ResolveOptions['bisCountScope'],
    bisCounts,
  };
  return { options, weightOff: Number(settings.bisCountWeightOff) };
}
