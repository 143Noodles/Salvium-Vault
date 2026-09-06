import auditPeriods from './auditPeriods.json';

export function auditReturnHeight(network: string, height: number): number {
  if (!Number.isSafeInteger(height) || height < 0) throw new Error('Invalid Audit height');
  if (network === 'testnet' || network === 'stagenet') return height + 7201;
  if (network !== 'mainnet') throw new Error('Unknown Audit network');
  const period = auditPeriods.find(p => height >= p.start && height < p.endExclusive);
  if (!period) throw new Error('Audit transaction outside canonical mainnet Audit epochs');
  return height + period.returnOffset;
}
