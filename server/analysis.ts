import { db } from './db.js';

// Marius Bakken intensity zones based on % of max HR
// Estimated max HR from user's test data and race results
const DEFAULT_MAX_HR = 200;

type Zone = 'easy' | 'gray' | 'threshold' | 'above';

const ZONE_LABELS: Record<Zone, string> = {
  easy: 'Rolig (sone 1-2)',
  gray: 'Grå sone',
  threshold: 'Terskel',
  above: 'Over terskel',
};

// Bakken zones as % of max HR:
//   Easy:      <80% (recovery + aerobic base)
//   Gray zone: 80-87% (too hard for easy, too easy for threshold)
//   Threshold: 87-93% (lactate threshold range)
//   Above:     >93% (VO2max / anaerobic)
function classifyHR(hr: number, maxHR: number): Zone {
  const pct = hr / maxHR;
  if (pct < 0.80) return 'easy';
  if (pct < 0.87) return 'gray';
  if (pct < 0.93) return 'threshold';
  return 'above';
}

export type MonthlyZoneData = {
  month: string; // YYYY-MM
  total_runs: number;
  total_time_min: number;
  total_distance_km: number;
  easy_min: number;
  gray_min: number;
  threshold_min: number;
  above_min: number;
  easy_pct: number;
  gray_pct: number;
  threshold_pct: number;
  above_pct: number;
  unclassified_min: number;
};

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
      // Add remaining time (splits without HR) as unclassifiable — use overall avg
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

export function getMonthlyZoneAnalysis(maxHR: number = DEFAULT_MAX_HR): MonthlyZoneData[] {
  const activities = db
    .prepare(
      `SELECT * FROM activities
       WHERE type = 'Run' AND start_date >= '2020-01-01'
       ORDER BY start_date ASC`,
    )
    .all() as any[];

  const monthMap = new Map<string, {
    runs: number;
    time: number;
    distance: number;
    easy: number;
    gray: number;
    threshold: number;
    above: number;
    unclassified: number;
  }>();

  for (const act of activities) {
    const month = act.start_date.slice(0, 7); // YYYY-MM
    if (!monthMap.has(month)) {
      monthMap.set(month, {
        runs: 0, time: 0, distance: 0,
        easy: 0, gray: 0, threshold: 0, above: 0, unclassified: 0,
      });
    }
    const m = monthMap.get(month)!;
    m.runs++;
    m.time += (act.moving_time || 0) / 60;
    m.distance += (act.distance || 0) / 1000;

    const zones = analyzeActivityZones(act, maxHR);
    const classified = zones.easy + zones.gray + zones.threshold + zones.above;

    if (classified > 0) {
      m.easy += zones.easy;
      m.gray += zones.gray;
      m.threshold += zones.threshold;
      m.above += zones.above;
    } else {
      m.unclassified += (act.moving_time || 0) / 60;
    }
  }

  const result: MonthlyZoneData[] = [];
  for (const [month, m] of monthMap) {
    const classifiedTotal = m.easy + m.gray + m.threshold + m.above;
    result.push({
      month,
      total_runs: m.runs,
      total_time_min: Math.round(m.time),
      total_distance_km: Math.round(m.distance),
      easy_min: Math.round(m.easy),
      gray_min: Math.round(m.gray),
      threshold_min: Math.round(m.threshold),
      above_min: Math.round(m.above),
      easy_pct: classifiedTotal > 0 ? Math.round((m.easy / classifiedTotal) * 100) : 0,
      gray_pct: classifiedTotal > 0 ? Math.round((m.gray / classifiedTotal) * 100) : 0,
      threshold_pct: classifiedTotal > 0 ? Math.round((m.threshold / classifiedTotal) * 100) : 0,
      above_pct: classifiedTotal > 0 ? Math.round((m.above / classifiedTotal) * 100) : 0,
      unclassified_min: Math.round(m.unclassified),
    });
  }

  return result;
}

export { ZONE_LABELS, DEFAULT_MAX_HR };
