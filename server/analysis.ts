// Marius Bakken intensity zones based on % of max HR.
// maxHR is supplied per call (per-tenant in multi-tenant setup).
const DEFAULT_MAX_HR = 200;

type Zone = 'easy' | 'gray' | 'threshold' | 'above';

// Bakken zones as % of max HR (per Bakken-modellen):
//   Easy/Rolig:   <70% (recovery + aerobic base)
//   Gray/Grå:     70-80% (too hard for easy, too easy for threshold — avoid)
//   Threshold:    80-87% ("den gylne sonen" — the golden threshold zone)
//   Above:        >87% (over threshold + VO2max / anaerobic)
function classifyHR(hr: number, maxHR: number): Zone {
  const pct = hr / maxHR;
  if (pct < 0.70) return 'easy';
  if (pct < 0.80) return 'gray';
  if (pct < 0.87) return 'threshold';
  return 'above';
}

// Fordeler en økts tid på soner (i minutter). Bruker splits → laps → snittpuls.
function analyzeActivityZones(
  activity: any,
  maxHR: number,
): Record<Zone, number> {
  const zones: Record<Zone, number> = { easy: 0, gray: 0, threshold: 0, above: 0 };

  const detail = activity.detail_json ? JSON.parse(activity.detail_json) : null;

  // Strategy 1: Use splits_metric from detail (per-km data with HR)
  if (detail?.splits_metric) {
    const splitsWithHR = detail.splits_metric.filter(
      (s: any) => s.average_heartrate && s.moving_time,
    );
    if (splitsWithHR.length > 0) {
      for (const split of splitsWithHR) {
        const zone = classifyHR(split.average_heartrate, maxHR);
        zones[zone] += split.moving_time / 60;
      }
      // Add remaining time (splits without HR) using overall avg
      const classifiedTime = splitsWithHR.reduce(
        (sum: number, s: any) => sum + s.moving_time,
        0,
      );
      const totalTime = activity.moving_time;
      if (totalTime > classifiedTime && activity.average_heartrate) {
        const remainingMin = (totalTime - classifiedTime) / 60;
        const zone = classifyHR(activity.average_heartrate, maxHR);
        zones[zone] += remainingMin;
      }
      return zones;
    }
  }

  // Strategy 2: Use laps from detail
  if (detail?.laps) {
    const lapsWithHR = detail.laps.filter(
      (l: any) => l.average_heartrate && l.moving_time,
    );
    if (lapsWithHR.length > 0) {
      for (const lap of lapsWithHR) {
        const zone = classifyHR(lap.average_heartrate, maxHR);
        zones[zone] += lap.moving_time / 60;
      }
      return zones;
    }
  }

  // Strategy 3: Fall back to overall average HR
  if (activity.average_heartrate && activity.moving_time) {
    const zone = classifyHR(activity.average_heartrate, maxHR);
    zones[zone] += activity.moving_time / 60;
    return zones;
  }

  return zones;
}

export { DEFAULT_MAX_HR, analyzeActivityZones };
export type { Zone };
