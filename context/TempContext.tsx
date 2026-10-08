import { get, onValue, push, ref, set, update } from 'firebase/database';
import React, { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { DUPLICATE_WRITE_GRACE_MS, getTempStatus, isReadingStale, parseDeviceTimestamp, STALE_AFTER_MS, STATUS_CONFIRMATION_READINGS, TARGET_TEMP, TempStatus } from '../constants/temperature';
import { rtdb } from '../firebaseConfig';
import { fireLocalNotification } from '../utils/localNotifications';
import { useNotificationPreference } from './NotificationPreferenceContext';

const STATUS_NOTIFICATION_STYLE: Record<TempStatus, { iconColor: string; iconBg: string }> = {
  offline: { iconColor: '#757575', iconBg: '#EEEEEE' },
  critical: { iconColor: '#E53935', iconBg: '#FFEBEE' },
  fault: { iconColor: '#F2994A', iconBg: '#FFF6E6' },
  cooling: { iconColor: '#2F6FED', iconBg: '#EAF3FF' },
  optimal: { iconColor: '#3FA66E', iconBg: '#EAFFF2' },
  warming: { iconColor: '#F2994A', iconBg: '#FFF6E6' },
};

// Shared across devices in RTDB (rather than per-device AsyncStorage) so
// two phones watching the same pen don't each independently notify for
// the same status transition.
const LAST_STATUS_PATH = 'notifications_state/lastStatus';
// Same reasoning as LAST_STATUS_PATH, tracked separately since staleness
// is an independent concern from the sensor-value status above it.
const LAST_STALE_PATH = 'notifications_state/lastStale';

// 1. Define the shape of our context data with Firebase properties
type TempContextType = {
  currentTemp: number | null;
  humidity: number | null;
  targetTemp: number | null;
  // When the DEVICE says the current reading was taken (epoch ms), from
  // sensors/farrowing/lastUpdate - null when the firmware doesn't write
  // that field (or writes something unusable). null means "unknown", not
  // "stale": without a device timestamp the app can't tell a live reading
  // from a replayed old one, and doesn't guess. Never derived from the
  // app's own clock or from when a snapshot happened to arrive.
  lastUpdate: number | null;
  // True once lastUpdate is more than STALE_AFTER_MS old by server time.
  // Always false while lastUpdate is null (unknown). Ticks on its own via
  // a timer, so it flips true from time passing alone.
  isStale: boolean;
  updateTemperature: (newTarget: number) => Promise<void>;
};

// 2. Create the context with a default of undefined
const TempContext = createContext<TempContextType | undefined>(undefined);

// 3. The Provider component (kept as TemperatureProvider to match your app root)
export const TemperatureProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [currentTemp, setCurrentTemp] = useState<number | null>(null);
  const [humidity, setHumidity] = useState<number | null>(null);
  const [targetTemp, setTargetTemp] = useState<number | null>(TARGET_TEMP);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [isStale, setIsStale] = useState(false);
  const { isNotificationsEnabled } = useNotificationPreference();

  // Status-transition debounce state. Refs so updates don't trigger
  // re-renders or re-run the listener effect.
  const lastNotifiedStatus = useRef<TempStatus | null>(null);
  const pendingStatus = useRef<TempStatus | null>(null);
  const pendingCount = useRef(0);
  const lastProcessedAt = useRef<number | null>(null);
  const lastNotifiedStale = useRef<boolean>(false);

  // The sensor listener effect below intentionally mounts once ([]), so
  // it can't read isNotificationsEnabled directly without going stale -
  // this ref keeps it current without re-attaching the listener.
  const isNotificationsEnabledRef = useRef(isNotificationsEnabled);
  useEffect(() => {
    isNotificationsEnabledRef.current = isNotificationsEnabled;
  }, [isNotificationsEnabled]);

  // Fires a notification on a false<->true isStale transition. Compares
  // against the ref (not React state) so it's independent of render
  // timing, and is a no-op if nextIsStale matches what was last
  // notified - that's what stops it refiring on every 30s tick while
  // still stale. Same push+persist+fireLocalNotification shape as the
  // sensor-status notifications above, but a separate, independent
  // concern from that debounce machinery - staleness is already
  // time-gated by STALE_AFTER_MS itself, so no confirmation-count is
  // needed on top of it.
  const notifyStaleTransition = (nextIsStale: boolean) => {
    if (nextIsStale === lastNotifiedStale.current) return;

    const previousNotifiedStale = lastNotifiedStale.current;
    lastNotifiedStale.current = nextIsStale;

    const title = nextIsStale ? 'Sensor Offline' : 'Sensor Back Online';
    const body = nextIsStale
      ? `No new temperature readings for ${Math.round(STALE_AFTER_MS / 60000)}+ minutes.`
      : 'Temperature readings have resumed.';
    const { iconColor, iconBg } = STATUS_NOTIFICATION_STYLE[nextIsStale ? 'offline' : 'optimal'];

    const newNotifRef = push(ref(rtdb, 'notifications'));
    if (!newNotifRef.key) return;

    update(ref(rtdb), {
      [`notifications/${newNotifRef.key}`]: {
        title,
        body,
        type: 'Temperature',
        timestamp: Date.now(),
        unread: true,
        iconColor,
        iconBg,
      },
      [LAST_STALE_PATH]: nextIsStale,
    })
      .then(() => {
        fireLocalNotification(isNotificationsEnabledRef.current, title, body);
      })
      .catch((error) => {
        console.error('Failed to create staleness notification:', error);
        lastNotifiedStale.current = previousNotifiedStale;
      });
  };

  // Staleness is judged ONLY from the device's own sensors/farrowing/
  // lastUpdate timestamp against server time. It is never inferred from
  // when a snapshot arrived: onValue replays the last stored value the
  // moment a listener attaches, and any write to the node (including the
  // app's own targetTemp writes) fires it, so arrival time says nothing
  // about whether the device is alive - that inference produced a false
  // "Sensor Back Online" off a user's own target change.
  //
  // Refs, because the effects below mount once ([]) and must read the
  // latest values without going stale or re-attaching listeners.
  const lastUpdateRef = useRef<number | null>(null);
  // Phone clock -> server clock offset (ms), from .info/serverTimeOffset,
  // so a phone whose clock is a few minutes off doesn't put a reading on
  // the wrong side of the threshold.
  const serverOffsetRef = useRef(0);
  const serverOffsetKnownRef = useRef(false);

  const evaluateStaleness = () => {
    // Hold off until the offset is known - judging with an uncorrected
    // phone clock could flip staleness (and fire a notification) wrongly.
    if (!serverOffsetKnownRef.current) return;

    const last = lastUpdateRef.current;
    if (last === null) {
      // No device timestamp = unknown, not stale. No transition is
      // evaluated, so no stale / back-online notification can fire.
      setIsStale(false);
      return;
    }

    const nextIsStale = isReadingStale(last, Date.now() + serverOffsetRef.current);
    setIsStale(nextIsStale);
    notifyStaleTransition(nextIsStale);
  };

  // Ticks purely from time passing - this is what flips isStale to true
  // when the device goes silent, since no new RTDB event arrives then.
  useEffect(() => {
    const interval = setInterval(evaluateStaleness, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeOffset: (() => void) | undefined;

    const start = async () => {
      // Read the persisted status BEFORE attaching the sensor listener,
      // so a cold start can't process incoming readings before it knows
      // what a previous session (or another device) already notified.
      try {
        const stateSnap = await get(ref(rtdb, LAST_STATUS_PATH));
        if (stateSnap.exists()) {
          lastNotifiedStatus.current = stateSnap.val() as TempStatus;
        }
      } catch (error) {
        console.error('Failed to read persisted notification status:', error);
      }

      // Same reasoning as above, for staleness: a relaunch while the
      // sensor is still offline shouldn't be able to refire "Sensor
      // Offline" just because this session doesn't remember sending it.
      try {
        const staleSnap = await get(ref(rtdb, LAST_STALE_PATH));
        if (staleSnap.exists()) {
          lastNotifiedStale.current = Boolean(staleSnap.val());
        }
      } catch (error) {
        console.error('Failed to read persisted stale-notification state:', error);
      }

      if (!isMounted) return;

      // Server-clock offset, so staleness is judged against server time
      // instead of a possibly-skewed phone clock. If it can't be read,
      // fall back to the phone clock (offset 0) rather than never judging.
      unsubscribeOffset = onValue(
        ref(rtdb, '.info/serverTimeOffset'),
        (offsetSnap) => {
          const offset = offsetSnap.val();
          serverOffsetRef.current =
            typeof offset === 'number' && Number.isFinite(offset) ? offset : 0;
          serverOffsetKnownRef.current = true;
          evaluateStaleness();
        },
        () => {
          serverOffsetRef.current = 0;
          serverOffsetKnownRef.current = true;
          evaluateStaleness();
        }
      );

      const sensorRef = ref(rtdb, 'sensors/farrowing');

      unsubscribe = onValue(
        sensorRef,
        (snapshot) => {
          if (snapshot.exists()) {
            const data = snapshot.val();
            const nextTemperature = data.currentTemp !== undefined ? Number(data.currentTemp) : null;

            setCurrentTemp(nextTemperature);
            setHumidity(data.humidity !== undefined ? Number(data.humidity) : null);
            setTargetTemp(data.targetTemp !== undefined ? Number(data.targetTemp) : TARGET_TEMP);

            // Firmware contract: sensors/farrowing/lastUpdate is when the
            // device took this reading - an RTDB server timestamp
            // ({".sv":"timestamp"}, epoch ms), written in the same update
            // as currentTemp/humidity. Epoch seconds are accepted too.
            // Absent or unusable (e.g. an unsynced clock) parses to null,
            // which means "unknown": no staleness is judged and no
            // stale / back-online notification can fire. This is also
            // what makes a cold start correct - the replayed first
            // snapshot carries its own age, so a sensor that was already
            // dead before the app opened is caught immediately.
            //
            // Until the firmware writes the field, the app can't know
            // how old a reading is and says so ("Last updated: unknown")
            // rather than guessing from arrival time.
            const parsedLastUpdate = parseDeviceTimestamp(
              data.lastUpdate,
              Date.now() + serverOffsetRef.current
            );
            lastUpdateRef.current = parsedLastUpdate;
            setLastUpdate(parsedLastUpdate);
            evaluateStaleness();

            if (nextTemperature === null || !Number.isFinite(nextTemperature)) {
              return;
            }

            const now = Date.now();

            // The firmware still writes currentTemp and humidity to
            // sensors/farrowing as separate calls, so a single physical
            // reading can fire this listener twice within milliseconds.
            // We can't fix that at the source from here, so we collapse
            // any fire that lands within DUPLICATE_WRITE_GRACE_MS of the
            // last one we actually processed - the duplicate write
            // itself still happens, we're just filtering it client-side.
            const isLikelyDuplicateWrite =
              lastProcessedAt.current !== null && now - lastProcessedAt.current < DUPLICATE_WRITE_GRACE_MS;

            if (isLikelyDuplicateWrite) {
              return;
            }

            lastProcessedAt.current = now;

            const { status, label } = getTempStatus(nextTemperature);

            if (status === pendingStatus.current) {
              pendingCount.current += 1;
            } else {
              pendingStatus.current = status;
              pendingCount.current = 1;
            }

            const isConfirmed = pendingCount.current >= STATUS_CONFIRMATION_READINGS;
            const isNewStatus = status !== lastNotifiedStatus.current;

            // Only notify once a status has held for enough consecutive
            // readings to rule out a transient blip, and only when it's
            // actually different from the status we last notified about.
            if (isConfirmed && isNewStatus) {
              const { iconColor, iconBg } = STATUS_NOTIFICATION_STYLE[status];
              const newNotifRef = push(ref(rtdb, 'notifications'));

              if (newNotifRef.key) {
                const previousNotifiedStatus = lastNotifiedStatus.current;
                // Optimistic: mark as notified immediately so a reading
                // that lands while this write is still in flight can't
                // trigger a second push for the same transition.
                lastNotifiedStatus.current = status;

                // Single multi-path update: the notification and the
                // persisted lastStatus are written atomically, so we
                // never end up with one recorded and not the other.
                update(ref(rtdb), {
                  [`notifications/${newNotifRef.key}`]: {
                    title: 'Temperature Reading',
                    body: `${label} — ${nextTemperature.toFixed(1)}°C`,
                    type: 'Temperature',
                    timestamp: Date.now(),
                    unread: true,
                    iconColor,
                    iconBg,
                  },
                  [LAST_STATUS_PATH]: status,
                })
                  .then(() => {
                    // Only fires once the in-app record is actually
                    // written, so a banner can't appear without one.
                    fireLocalNotification(
                      isNotificationsEnabledRef.current,
                      'Temperature Reading',
                      `${label} — ${nextTemperature.toFixed(1)}°C`
                    );
                  })
                  .catch((error) => {
                    console.error('Failed to create temperature notification:', error);
                    // Roll back so the next confirmed reading retries.
                    lastNotifiedStatus.current = previousNotifiedStatus;
                  });
              }
            }
          }
        },
        (error) => {
          console.error('Firebase DB Error:', error);
        }
      );
    };

    start();

    return () => {
      isMounted = false;
      unsubscribe?.();
      unsubscribeOffset?.();
    };
  }, []);

  // Updates the target temperature directly in Firebase
  const updateTemperature = async (newTarget: number) => {
    try {
      const targetRef = ref(rtdb, 'sensors/farrowing/targetTemp');
      await set(targetRef, newTarget);
    } catch (error) {
      console.error('Error updating temperature in Firebase:', error);
    }
  };

  return (
    <TempContext.Provider
      value={{ currentTemp, humidity, targetTemp, lastUpdate, isStale, updateTemperature }}
    >
      {children}
    </TempContext.Provider>
  );
};

// 4. Custom hook to consume the context
export const useTemp = () => {
  const context = useContext(TempContext);

  if (context === undefined) {
    throw new Error('useTemp must be used within a TemperatureProvider');
  }

  return context;
};