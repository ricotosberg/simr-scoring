export function sessionMultiplier(session, scoringConfig) {
  const sorted = [...(scoringConfig || [])].sort((a, b) => a.position - b.position);
  const baseMaximum = Number(sorted[0]?.points ?? 20);
  if (baseMaximum <= 0) return 1;
  return Number(session?.points_max ?? baseMaximum) / baseMaximum;
}

export function calculateSessionPoints(session, results, scoringConfig) {
  const configByPosition = new Map(
    [...(scoringConfig || [])].map(row => [Number(row.position), Number(row.points)])
  );
  const multiplier = sessionMultiplier(session, scoringConfig);
  const classifiedPositions = (results || [])
    .filter(result => !result.dnf && result.position != null)
    .map(result => Number(result.position));
  const lastClassifiedPosition = classifiedPositions.length
    ? Math.max(...classifiedPositions)
    : null;
  const dnfBasePoints = lastClassifiedPosition == null
    ? 0
    : (configByPosition.get(lastClassifiedPosition) ?? 0);

  return Object.fromEntries((results || []).map(result => {
    const basePoints = result.dnf
      ? dnfBasePoints
      : (configByPosition.get(Number(result.position)) ?? 0);
    return [result.driver_id, Math.round(basePoints * multiplier)];
  }));
}

export function calculateDropRound(eventPoints, completedEventIds, enabled = true) {
  if (!enabled || completedEventIds.length < 2) {
    return { droppedEventId: null, droppedPoints: 0 };
  }

  let droppedEventId = null;
  let droppedPoints = Infinity;
  for (const eventId of completedEventIds) {
    const points = Number(eventPoints[eventId] ?? 0);
    if (points < droppedPoints) {
      droppedPoints = points;
      droppedEventId = eventId;
    }
  }

  return { droppedEventId, droppedPoints };
}
