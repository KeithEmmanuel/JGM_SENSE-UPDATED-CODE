// Optimal piglet brooding range: 32-35°C.
// Source: EW Nutrition (2024); Estienne (2024).
export const OPTIMAL_MIN = 32;
export const OPTIMAL_MAX = 35;
export const TARGET_TEMP = 32;

// Fault-detection thresholds are NOT husbandry guidance. They are derived
// from system logic (expected heat-lamp response curve) to flag suspected
// equipment failure before a reading drifts into the critical range.
export const FAULT_DETECT_LOW = 27;
export const FAULT_DETECT_HIGH = 36;

export const CRITICAL_LOW = 24;
export const CRITICAL_HIGH = 38;

// Number of consecutive readings a status must hold before it's treated
// as a real transition worth notifying about. This debounces transient
// dips/spikes (e.g. a gust of wind briefly cooling the sensor) so a
// reading that recovers before this many samples never raises an alert.
export const STATUS_CONFIRMATION_READINGS = 3;

// Minimum gap between processed sensor writes. The firmware writes
// currentTemp and humidity to sensors/farrowing as separate calls, so a
// single physical reading can still fire the RTDB listener twice within
// milliseconds. This is a client-side filter for that, not a fix - the
// duplicate writes themselves are still happening at the source.
export const DUPLICATE_WRITE_GRACE_MS = 2000;

// How old the device-reported sensors/farrowing/lastUpdate can get before
// the last known reading is treated as stale rather than current. Chosen
// to tolerate normal gaps between readings (the old notification log
// showed up to ~3.5 min between consecutive readings) while still
// catching a dead device reasonably promptly. Provisional: 5 min is only
// ~1.4x that longest observed gap - confirm against the firmware's real
// write interval (it should be at least ~3x it) before relying on it.
export const STALE_AFTER_MS = 5 * 60 * 1000;

// Device timestamps before this can't be real readings - e.g. an ESP32
// that hasn't synced its clock reports seconds-since-boot, which lands in
// 1970 once normalized. Treated as "no timestamp" rather than "very old".
const MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(2020, 0, 1);
// A timestamp further ahead of server time than this is clock garbage,
// not a reading from the future.
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

// Parses sensors/farrowing/lastUpdate into epoch milliseconds, or null
// when it's absent or unusable. The firmware contract is an RTDB server
// timestamp ({".sv":"timestamp"}, epoch ms), but epoch seconds are
// accepted too: any value below 1e11 is read as seconds (1e11 seconds is
// the year 5138, while 1e11 ms is 1973, so the two ranges can't collide
// for any date this app will see). `serverNow` is the current time on the
// server's clock (phone clock corrected by .info/serverTimeOffset).
export function parseDeviceTimestamp(raw: unknown, serverNow: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;

  const ms = raw < 1e11 ? raw * 1000 : raw;
  if (ms < MIN_PLAUSIBLE_EPOCH_MS) return null;
  if (ms > serverNow + MAX_FUTURE_SKEW_MS) return null;
  return ms;
}

// True once the reading is more than STALE_AFTER_MS old. Strictly
// greater-than, so a reading exactly at the threshold is still fresh.
export function isReadingStale(lastUpdateMs: number, serverNow: number): boolean {
  return serverNow - lastUpdateMs > STALE_AFTER_MS;
}

// 'fault' is an equipment-failure indicator (suspected heat lamp or
// component failure), not a severity rung between 'critical' and
// 'cooling'/'warming'. Don't treat this type as an ordered scale -
// a 'fault' reading can occur on either side of the optimal band and
// should be handled as its own signal, not compared for "more/less severe".
export type TempStatus = 'offline' | 'critical' | 'fault' | 'cooling' | 'optimal' | 'warming';

export interface TempStatusResult {
  status: TempStatus;
  label: string;
}

export function getTempStatus(temp: number | null | undefined): TempStatusResult {
  if (temp === null || temp === undefined || !Number.isFinite(temp)) {
    return { status: 'offline', label: 'Offline' };
  }
  if (temp <= CRITICAL_LOW || temp >= CRITICAL_HIGH) {
    return { status: 'critical', label: 'Critical' };
  }
  if (temp <= FAULT_DETECT_LOW || temp >= FAULT_DETECT_HIGH) {
    return { status: 'fault', label: 'Warning' };
  }
  if (temp < OPTIMAL_MIN) {
    return { status: 'cooling', label: 'Cooling Needed' };
  }
  if (temp > OPTIMAL_MAX) {
    return { status: 'warming', label: 'Above Optimal' };
  }
  return { status: 'optimal', label: 'Optimal' };
}
