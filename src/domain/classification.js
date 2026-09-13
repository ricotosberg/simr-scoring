export const DEFAULT_CLASSIFICATION_THRESHOLDS = Object.freeze({
  platinum: 72,
  gold: 55,
  silver: 35,
  minimumStarts: 5
});

export function classifyDriverByEfficiency(efficiency, starts, thresholds = {}) {
  if (efficiency === null || efficiency === undefined) return 'U';

  const configured = {
    ...DEFAULT_CLASSIFICATION_THRESHOLDS,
    platinum: thresholds.platinum ?? thresholds.p,
    gold: thresholds.gold ?? thresholds.g,
    silver: thresholds.silver ?? thresholds.s,
    minimumStarts: thresholds.minimumStarts ?? thresholds.minimum_starts
  };

  configured.platinum ??= DEFAULT_CLASSIFICATION_THRESHOLDS.platinum;
  configured.gold ??= DEFAULT_CLASSIFICATION_THRESHOLDS.gold;
  configured.silver ??= DEFAULT_CLASSIFICATION_THRESHOLDS.silver;
  configured.minimumStarts ??= DEFAULT_CLASSIFICATION_THRESHOLDS.minimumStarts;

  if ((starts || 0) < configured.minimumStarts) return 'U';
  if (efficiency >= configured.platinum) return 'P';
  if (efficiency >= configured.gold) return 'G';
  if (efficiency >= configured.silver) return 'S';
  return 'B';
}
