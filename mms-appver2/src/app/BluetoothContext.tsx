"use client";

import React, { createContext, useState, useContext, useRef, useEffect } from "react";

// Simplified Bluetooth context for sensor-only UI
interface BluetoothSample {
  value: number;
  ts: number; // performance.now() timestamp in ms
}

interface BluetoothContextType {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  isConnected: boolean;
  sendCommand: (...args: (string | number)[]) => Promise<void>;
  imuData: { imu1_changes: BluetoothSample[]; imu2_changes: BluetoothSample[] };
  startIMU: () => Promise<void>;
  stopIMU: () => Promise<void>;
  clearIMU: () => void;
}

export const BluetoothContext = createContext<BluetoothContextType | undefined>(undefined);

export const BluetoothProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [device, setDevice] = useState<BluetoothDevice | null>(null);
  const [rxCharacteristic, setRxCharacteristic] = useState<BluetoothRemoteGATTCharacteristic | null>(null);
  const [txCharacteristic, setTxCharacteristic] = useState<BluetoothRemoteGATTCharacteristic | null>(null);

  const deviceRef = useRef<BluetoothDevice | null>(null);
  const isManualDisconnectRef = useRef(false);

  const [imuData, setImuData] = useState<{ imu1_changes: BluetoothSample[]; imu2_changes: BluetoothSample[] }>({ imu1_changes: [], imu2_changes: [] });
  const imuDataRef = useRef(imuData);
  useEffect(() => {
    imuDataRef.current = imuData;
  }, [imuData]);

  // Track last notification timestamp so we can distribute per-notification samples
  // across the measured notification interval (reduces compressed "comb" spikes).
  const lastNotificationTsRef = useRef<number | null>(null);
  // Small debug logger: limit to first N notifications so we don't flood the console
  const debugLogRef = useRef<number>(0);
  // Conditional spike/burst analysis configuration
  const SPIKE_MAG_THRESHOLD = 1000; // magnitude above which we consider the packet a spike (raised to reduce console noise)
  const BURST_SAMPLE_COUNT_THRESHOLD = 12; // many samples in a single notification
  const SMALL_INTERVAL_THRESHOLD = 6; // ms per-sample considered very small (indicates compression)
  const RECENT_WINDOW_MS = 1000; // window to consider recent notifications
  const RECENT_COUNT_THRESHOLD = 6; // number of notifications in window to flag a burst
  const recentNotificationsRef = useRef<number[]>([]);
  // Recent raw-payload hash map to debounce duplicate windows for display.
  const DUP_WINDOW_MS = 250; // if identical raw payload seen within this window, skip display append
  const recentRawHashRef = useRef<Map<string, number>>(new Map());
  // NOTE: spike/burst forensic log removed per user request. Keep dedupe and
  // display behavior; providers no longer record a separate in-memory spike log.

  // Nordic UART Service UUIDs
  const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  const RX_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
  const TX_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

  const connect = async (): Promise<void> => {
    try {
      const selectedDevice = await navigator.bluetooth.requestDevice({
        filters: [{ name: "MMS nus" }],
        optionalServices: [SERVICE_UUID]
      });

      if (deviceRef.current) {
        deviceRef.current.removeEventListener("gattserverdisconnected", handleDisconnection);
      }

      const server = await selectedDevice.gatt?.connect();
      const service = await server?.getPrimaryService(SERVICE_UUID);
      const rxChar = await service?.getCharacteristic(RX_CHARACTERISTIC_UUID);
      const txChar = await service?.getCharacteristic(TX_CHARACTERISTIC_UUID);

      if (txChar) {
        // Start notifications, but avoid adding duplicate listeners.
        await txChar.startNotifications();
        try {
          // remove any previous listener reference first
          txChar.removeEventListener("characteristicvaluechanged", handleIncomingData);
        } catch (e) {
          // ignore if none
        }
        txChar.addEventListener("characteristicvaluechanged", handleIncomingData);
      }

      setRxCharacteristic(rxChar || null);
      setTxCharacteristic(txChar || null);
      setDevice(selectedDevice);
      deviceRef.current = selectedDevice;
      setIsConnected(true);

      // Keep lightweight connection logs for diagnostics
      try {
        console.log(`Bluetooth connected: ${selectedDevice.name ?? selectedDevice.id}`);
        if (rxChar) console.log('RX characteristic available');
        if (txChar) console.log('TX characteristic available');
      } catch (e) {
        // ignore logging errors in restricted environments
      }

      selectedDevice.addEventListener("gattserverdisconnected", handleDisconnection);
    } catch (err) {
      console.error("Bluetooth connect failed:", err);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (deviceRef.current) {
      isManualDisconnectRef.current = true;
      deviceRef.current.removeEventListener("gattserverdisconnected", handleDisconnection);

      if (deviceRef.current.gatt?.connected) {
        deviceRef.current.gatt.disconnect();
      }

      // Clear provider IMU data on disconnect so UI shows an empty buffer.
      setImuData({ imu1_changes: [], imu2_changes: [] });
      setIsConnected(false);
      setDevice(null);
      isManualDisconnectRef.current = false;
    }
  };

  const handleDisconnection = () => {
    if (isManualDisconnectRef.current) return;
    setIsConnected(false);
    setDevice(null);
  };

  const IDLE_VALUE = 2048;
  // No fixed maxHistory: keep appending samples to the provider arrays so
  // the UI or higher-level code can choose how much to display.
  // NOTE: this can grow unbounded in memory for very long sessions.
  // If you later want a rolling buffer, reintroduce a reasonable cap here.

  // Robust parser helper (placed here so it can capture IDLE_VALUE constant)
  class SensorDataProcessor {
    static IDLE_VALUE = IDLE_VALUE;

    static processRawBytesAsMagnitudes(bufferLike: ArrayBuffer | Uint8Array) {
      const bytes = bufferLike instanceof Uint8Array ? bufferLike : new Uint8Array(bufferLike);
      const byteLen = bytes.length;
      if (byteLen === 0) return { sensor1: [] as number[], sensor2: [] as number[] };

      const pairCount = Math.floor(byteLen / 4);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const s1: number[] = new Array(pairCount);
      const s2: number[] = new Array(pairCount);
      const raw1s: number[] = new Array(pairCount);
      const raw2s: number[] = new Array(pairCount);

      for (let i = 0; i < pairCount; i++) {
        const off = i * 4;
        const raw1 = dv.getUint16(off, true);
        const raw2 = dv.getUint16(off + 2, true);
        raw1s[i] = raw1;
        raw2s[i] = raw2;
        s1[i] = Math.abs(raw1 - SensorDataProcessor.IDLE_VALUE);
        s2[i] = Math.abs(raw2 - SensorDataProcessor.IDLE_VALUE);
      }

      return { sensor1: s1, sensor2: s2, raw1s, raw2s };
    }
  }

  const handleIMUData = (rawBytes: Uint8Array) => {
    try {
  const parsed = SensorDataProcessor.processRawBytesAsMagnitudes(rawBytes);
  // parsed contains sensor1/sensor2 magnitudes and raw1s/raw2s arrays
  const { sensor1, sensor2, raw1s, raw2s } = parsed as any;

      // Build a per-pair inspection array for debugging.
      const pairs: Array<{ idx: number; d1: number | null; d2: number | null }> = [];
      const maxPairs = Math.max(sensor1.length, sensor2.length);
      for (let i = 0; i < maxPairs; i++) {
        const d1 = i < sensor1.length ? sensor1[i] : null;
        const d2 = i < sensor2.length ? sensor2[i] : null;
        pairs.push({ idx: i, d1, d2 });
      }

      // Log a hex snippet (first 64 bytes) and the parsed pairs for quick inspection.
      // const hexSnippet = Array.from(rawBytes as Uint8Array)
      //   .slice(0, 64)
      //   .map((b) => (b as number).toString(16).padStart(2, "0"))
      //   .join(" ");
      // Debug logging removed for release; keep errors only.

      // Timestamp the notification and assign per-sample timestamps.
      // We try to distribute samples across the measured interval between
      // notifications when possible to avoid compressing many samples into a
      // very narrow time window (which causes the vertical "comb" visual).
      const baseTs = performance.now();
      const DEFAULT_SAMPLE_INTERVAL = 20; // ms (conservative default, e.g. 50Hz)
      const MIN_SAMPLE_INTERVAL = 5; // ms minimum spacing to avoid 0 or near-0 gaps

  // Determine the number of samples we need to distribute. Use the max of the two
      // sensor arrays so we don't divide by zero.
      const sampleCount = Math.max(sensor1.length, sensor2.length, 1);

      // Compute measured gap since last notification and derive a per-sample interval.
      let perSampleInterval = DEFAULT_SAMPLE_INTERVAL;
      if (lastNotificationTsRef.current !== null) {
        const gap = baseTs - (lastNotificationTsRef.current as number);
        // Distribute the gap across the samples; clamp to reasonable values.
        const measured = gap / sampleCount;
        if (measured >= MIN_SAMPLE_INTERVAL && measured < 10000) {
          perSampleInterval = measured;
        }
      }
      // Update last notification timestamp for next time
      lastNotificationTsRef.current = baseTs;

      // Build per-sensor samples with timestamps. We'll then align samples by
      // timestamp and only record/display pairs where both sensors have the same
      // timestamp. This prevents mismatched plotting when arrays have different
      // lengths and keeps the two channels synchronized in the UI.
      const makeSamples = (arr: number[]) =>
        arr.map((v: number, idx: number) => ({
          value: v,
          ts: baseTs - (arr.length - 1 - idx) * perSampleInterval,
        } as BluetoothSample));

      const sensor1Samples = makeSamples(sensor1);
      const sensor2Samples = makeSamples(sensor2);

      // Align by timestamps: build maps and take the intersection of timestamps.
      const map1 = new Map<number, number>();
      const map2 = new Map<number, number>();
      sensor1Samples.forEach(s => map1.set(Math.round(s.ts), s.value));
      sensor2Samples.forEach(s => map2.set(Math.round(s.ts), s.value));

      // Use rounded timestamps (ms) for intersection to avoid tiny floating
      // differences. Only keep samples that exist in both maps.
      const intersectionTs: number[] = [];
      for (const ts of map1.keys()) {
        if (map2.has(ts)) intersectionTs.push(ts);
      }
      intersectionTs.sort((a, b) => a - b);

      // Build aligned sample pairs
      const aligned1: BluetoothSample[] = [];
      const aligned2: BluetoothSample[] = [];
      for (const rts of intersectionTs) {
        aligned1.push({ ts: rts, value: map1.get(rts) as number });
        aligned2.push({ ts: rts, value: map2.get(rts) as number });
      }

      // We'll append only aligned samples so both channels remain index-aligned
      // for display. This also reduces artifacts when one channel has extra
      // trailing/leading samples.

      // Compute a lightweight hash of the raw payload so we can debounce
      // identical windows for display (some devices resend the same buffer).
      let isDuplicateWindow = false;
      try {
        const rawHash = (raw1s || []).join(',') + '|' + (raw2s || []).join(',');
        const lastSeen = recentRawHashRef.current.get(rawHash);
        if (lastSeen && (baseTs - lastSeen) < DUP_WINDOW_MS) {
          isDuplicateWindow = true;
        } else {
          recentRawHashRef.current.set(rawHash, baseTs);
        }
        // Purge old map entries to avoid unbounded growth
        for (const [h, t] of Array.from(recentRawHashRef.current.entries())) {
          if (baseTs - t > DUP_WINDOW_MS * 8) recentRawHashRef.current.delete(h);
        }
      } catch (e) {
        // ignore hashing errors
      }

      // Temporary debug logging: print raw bytes, parsed raw values, magnitudes and timestamps
      // for the first few notifications to help diagnose spikes. Limited to avoid flooding logs.
      try {
        if (debugLogRef.current < 6) {
          // debug logging removed for release builds; keep a small counter to preserve
          // the original intent (limit how many times this branch could run).
          debugLogRef.current += 1;
        }
      } catch (e) {
        // ignore logging errors
      }

      // Conditional spike/burst analysis
      try {
        const maxMag1 = sensor1.length ? Math.max(...sensor1) : 0;
        const maxMag2 = sensor2.length ? Math.max(...sensor2) : 0;
        const maxMag = Math.max(maxMag1, maxMag2);

        // Track recent notifications for burst analysis
        const now = baseTs;
        const recent = recentNotificationsRef.current;
        recent.push(now);
        // keep only items within RECENT_WINDOW_MS
        recentNotificationsRef.current = recent.filter((t) => now - t <= RECENT_WINDOW_MS);

        // Condition: large magnitude spike in this notification
        if (maxMag >= SPIKE_MAG_THRESHOLD) {
          // Spike detected. Console diagnostics suppressed per user request.
        }

        // Condition: large sampleCount or very small per-sample interval
        if (sampleCount >= BURST_SAMPLE_COUNT_THRESHOLD || perSampleInterval <= SMALL_INTERVAL_THRESHOLD) {
          // Burst detected. Console diagnostics suppressed per user request.
        }

        // Condition: many notifications recently -> log a burst event
        if (recentNotificationsRef.current.length >= RECENT_COUNT_THRESHOLD) {
          // rapid_notifications detected. Console diagnostics suppressed per user request.
        }
      } catch (e) {
        // ignore analysis errors
      }

      setImuData(prev => {
  // If this notification is a duplicate window (recent identical raw
  // payload), skip appending to the display buffers to avoid repeated
  // spikes showing up visually. Note: we no longer record a separate
  // in-memory spike/burst forensic log; display suppression remains.
        if (isDuplicateWindow) {
          // duplicate display window; suppression notice removed per user request
          return prev;
        }
        const out1 = prev.imu1_changes.slice();
        const out2 = prev.imu2_changes.slice();

        // Append aligned samples, but avoid re-adding identical samples that
        // already exist at the tail (simple dedupe). This checks the last
        // appended sample and skips if timestamp and values match.
        const last1 = out1.length ? out1[out1.length - 1] : null;
        const last2 = out2.length ? out2[out2.length - 1] : null;

        for (let i = 0; i < aligned1.length; i++) {
          const s1 = aligned1[i];
          const s2 = aligned2[i];
          // if the last samples are identical (ts and value) skip to avoid
          // duplicate repeated notification windows
          if (
            last1 && last2 &&
            last1.ts === s1.ts && last2.ts === s2.ts &&
            last1.value === s1.value && last2.value === s2.value
          ) {
            // already have this exact sample pair at the tail; skip
            continue;
          }
          out1.push(s1);
          out2.push(s2);
        }

        return { imu1_changes: out1, imu2_changes: out2 };
      });
    } catch (err) {
      console.error("Error parsing IMU data:", err);
    }
  };

  const handleIncomingData = (event: any) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    if (!target || !target.value) return;
  const rawBytes = new Uint8Array(target.value.buffer);
    handleIMUData(rawBytes);
  };

  const startIMU = async () => {
    if (!txCharacteristic) return;
    try {
      await sendCommand("b");
      txCharacteristic.addEventListener("characteristicvaluechanged", handleIncomingData);
      await txCharacteristic.startNotifications();
    } catch (err) {
      console.error("Failed to start IMU:", err);
    }
  };

  const stopIMU = async () => {
    if (!txCharacteristic) return;
    try {
      await sendCommand("B");
      // Remove the handler and stop notifications if possible.
      try { txCharacteristic.removeEventListener("characteristicvaluechanged", handleIncomingData); } catch (e) {}
      await txCharacteristic.stopNotifications();
    } catch (err) {
      console.error("Failed to stop IMU:", err);
    }
  };

  const clearIMU = () => {
  setImuData({ imu1_changes: [], imu2_changes: [] });
    // also reset local ref if used elsewhere
    imuDataRef.current = { imu1_changes: [], imu2_changes: [] };
  };

  const sendCommand = async (...args: (string | number)[]) => {
    if (!rxCharacteristic) {
      console.error("RX characteristic not found");
      return;
    }

    const commandBytes = new Uint8Array(
      args.flatMap(arg => typeof arg === "number" ? [arg & 0xff] : String(arg).split("").map(c => c.charCodeAt(0)))
    );

    try {
      await rxCharacteristic.writeValue(commandBytes);
    } catch (err) {
      console.error("Failed to send command:", err);
    }
  };

  // (Spike/burst forensic log removed; no exported helpers.)

  return (
    <BluetoothContext.Provider value={{
      connect,
      disconnect,
      isConnected,
      sendCommand,
      imuData,
      startIMU,
      stopIMU,
      clearIMU,
      // spike helpers removed
    }}>
      {children}
    </BluetoothContext.Provider>
  );
};

export const useBluetooth = () => {
  const context = useContext(BluetoothContext);
  if (!context) throw new Error("useBluetooth must be used within a BluetoothProvider");
  return context;
};