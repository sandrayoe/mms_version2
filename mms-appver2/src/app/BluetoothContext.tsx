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
  stimulate: (electrode1: number, electrode2: number, amplitude: number, runStop: boolean) => Promise<void>;
  imuData: { imu1_changes: BluetoothSample[]; imu2_changes: BluetoothSample[] };
  startIMU: () => Promise<void>;
  stopIMU: () => Promise<void>;
  clearIMU: () => void;
  lastResponse: string | null;
  initializeImpedance: (electrodes: number[]) => Promise<void>;
  measureImpedance: () => Promise<void>;
  impedanceData: Array<{timestamp: string; data: string}>;
  clearImpedanceData: () => void;
}

export const BluetoothContext = createContext<BluetoothContextType | undefined>(undefined);

export const BluetoothProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [device, setDevice] = useState<BluetoothDevice | null>(null);
  const [rxCharacteristic, setRxCharacteristic] = useState<BluetoothRemoteGATTCharacteristic | null>(null);
  const [txCharacteristic, setTxCharacteristic] = useState<BluetoothRemoteGATTCharacteristic | null>(null);
  const [lastResponse, setLastResponse] = useState<string | null>(null);
  const [impedanceData, setImpedanceData] = useState<Array<{timestamp: string; data: string}>>([]);

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

  // Logging control: set to true for verbose debugging; set to false to keep
  // console output minimal in production/testing.
  const VERBOSE_LOGGING = false;
  const log = (...args: any[]) => {
    if (!VERBOSE_LOGGING) return;
    try { console.log(...args); } catch (e) { /* ignore logging errors */ }
  };

  // Incoming raw notification queue to avoid doing heavy parsing directly in
  // the Bluetooth message handler. We drain this queue at a controlled rate
  // using a timer to avoid long 'message' or 'requestAnimationFrame' handlers
  // that cause devtools "[Violation]" messages.
  // Queue items now include arrival timestamp so we can preserve the
  // original notification time even if processing is deferred.
  const rawQueueRef = useRef<Array<{ bytes: Uint8Array; arrivalTs: number }>>([]);
  const rawQueueProcessingRef = useRef(false);
  const PROCESS_MS = 12; // ms between processing ticks (small latency)
  // Process a few notifications per tick so the queue doesn't backlog but
  // we also avoid long single-tick processing in the message handler.
  const BATCH_PER_TICK = 4; // number of notifications processed per tick

  // Pending aligned sample pairs buffer for throttled UI updates.
  const pairsRef = useRef<Array<{ s1: BluetoothSample; s2: BluetoothSample }>>([]);
  // Lower pending cap to bound memory and encourage timely draining.
  const PENDING_CAP = 2000; // maximum pending pairs to keep
  const DRAIN_MS = 33; // drain UI updates ~30Hz
  // Total items to consider draining per interval (we'll actually process
  // that total in small chunks to yield between microtasks and avoid any
  // long-running single JS task which causes devtools "[Violation]" logs).
  const MAX_DRAIN_PER_TICK = 256; // cap total items considered per drain
  const DRAIN_CHUNK_SIZE = 64; // chunk size processed per micro-yield
  const drainingRef = useRef(false);

  const processRawQueue = () => {
    rawQueueProcessingRef.current = false;
    try {
      const batch = rawQueueRef.current.splice(0, BATCH_PER_TICK);
      for (const item of batch) {
        try { handleIMUData(item); } catch (e) { /* swallow per-item errors */ }
      }
      if (rawQueueRef.current.length > 0) {
        // schedule next tick
        rawQueueProcessingRef.current = true;
        setTimeout(processRawQueue, PROCESS_MS);
      }
    } catch (e) {
      rawQueueProcessingRef.current = false;
    }
  };

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

      // Keep lightweight connection logs for diagnostics (gate behind verbose)
      log(`Bluetooth connected: ${selectedDevice.name ?? selectedDevice.id}`);
      if (rxChar) log('RX characteristic available');
      if (txChar) log('TX characteristic available');

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

  // Now accepts the queued item which includes arrival timestamp so
  // timestamps assigned to samples reflect when the notification arrived
  // rather than when it was processed.
  const handleIMUData = (item: { bytes: Uint8Array; arrivalTs: number }) => {
    try {
      const rawBytes = item.bytes;
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
  // Use the recorded arrival timestamp (when the message was received)
  // so per-sample timestamps track real time even if processing is delayed.
  const baseTs = (item && typeof item.arrivalTs === 'number') ? item.arrivalTs : performance.now();
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

      // If this notification is a duplicate window (recent identical raw
      // payload), skip appending to pending buffer to avoid repeated
      // spikes showing up visually.
  if (isDuplicateWindow) return;

      // Push aligned sample pairs into the pending buffer. The buffer is
      // drained at a fixed interval (DRAIN_MS) to batch updates and avoid
      // frequent React renders that cause requestAnimationFrame violations.
      for (let i = 0; i < aligned1.length; i++) {
        pairsRef.current.push({ s1: aligned1[i], s2: aligned2[i] });
      }
      // Trim if pending buffer grows too large
      if (pairsRef.current.length > PENDING_CAP) {
        pairsRef.current.splice(0, pairsRef.current.length - PENDING_CAP);
      }
    } catch (err) {
      console.error("Error parsing IMU data:", err);
    }
  };

  const handleIncomingData = (event: any) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    if (!target || !target.value) return;
    const rawBytes = new Uint8Array(target.value.buffer);
    
    // Try to detect if this is a text response (ASCII printable characters)
    // Text responses typically contain letters and are relatively short
    let isTextResponse = false;
    if (rawBytes.length > 0 && rawBytes.length < 50) {
      // Check if most bytes are printable ASCII (32-126) or common control chars (10, 13)
      const printableCount = Array.from(rawBytes).filter(
        b => (b >= 32 && b <= 126) || b === 10 || b === 13
      ).length;
      isTextResponse = printableCount / rawBytes.length > 0.8;
    }
    
    if (isTextResponse) {
      // Parse as text response
      try {
        const text = new TextDecoder().decode(rawBytes).trim();
        if (text.length > 0) {
          console.log('Device response:', text);
          setLastResponse(text);
          
          // Check if this is impedance data (numeric values, could be resistance measurements)
          // Impedance values are typically numeric strings, possibly with spaces or commas
          if (/^[\d\s,\.]+$/.test(text)) {
            // Create UTC+1 timestamp
            const now = new Date(Date.now() + 60 * 60 * 1000);
            const year = now.getUTCFullYear();
            const month = String(now.getUTCMonth() + 1).padStart(2, '0');
            const day = String(now.getUTCDate()).padStart(2, '0');
            const hours = String(now.getUTCHours()).padStart(2, '0');
            const minutes = String(now.getUTCMinutes()).padStart(2, '0');
            const seconds = String(now.getUTCSeconds()).padStart(2, '0');
            const milliseconds = String(now.getUTCMilliseconds()).padStart(3, '0');
            const timestamp = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}+01:00`;
            
            setImpedanceData(prev => [...prev, {timestamp, data: text}]);
            console.log('Impedance data captured:', text, 'at', timestamp);
          }
        }
      } catch (e) {
        // ignore decode errors
      }
    } else {
      // Process as IMU sensor data
      try {
        rawQueueRef.current.push({ bytes: rawBytes, arrivalTs: performance.now() });
      } catch (e) {
        // if push fails for some reason, try processing directly as a fallback
        try { handleIMUData({ bytes: rawBytes, arrivalTs: performance.now() }); } catch (ee) {}
        return;
      }

      if (!rawQueueProcessingRef.current) {
        rawQueueProcessingRef.current = true;
        setTimeout(processRawQueue, PROCESS_MS);
      }
    }
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

  const stimulate = async (electrode1: number, electrode2: number, amplitude: number, runStop: boolean) => {
    // Validate inputs
    if (electrode1 < 0 || electrode1 > 31 || electrode2 < 0 || electrode2 > 31) {
      console.error("Electrode numbers must be between 0 and 31");
      return;
    }
    if (amplitude < 0 || amplitude > 120) {
      console.error("Amplitude must be between 0 and 120 mA");
      return;
    }

    // Convert electrode numbers to ASCII digits
    // Device expects: UART2_Read() - '0', so we send ASCII characters '0' to '9' for electrodes 0-9
    // For electrodes 10-31, we use characters beyond '9' (e.g., ':' for 10, ';' for 11, etc.)
    const toAsciiDigit = (n: number) => String.fromCharCode(0x30 + n); // '0' + n
    
    // Build 8 electrode bytes (repeat electrode pair 4 times)
    const e1 = toAsciiDigit(electrode1);
    const e2 = toAsciiDigit(electrode2);
    const electrodes = e1 + e2 + e1 + e2 + e1 + e2 + e1 + e2;
    
    // Amplitude as 2 ASCII decimal digits (e.g., 50 -> '5' '0')
    // GetPacketBinASCII() reads 2 bytes and converts: (byte1 - '0') * 10 + (byte2 - '0')
    const ampStr = amplitude.toString().padStart(2, '0'); // e.g., "50" or "05"
    
    // Run/Stop: ASCII digit '0' or '1'
    // Device reads: UART2_Read() - '0', so we send '0' (0x30) or '1' (0x31)
    const runStopChar = runStop ? '1' : '0';
    
    // Send command: 'E' + 8 electrode ASCII chars + 2 amplitude ASCII digits + 1 runStop ASCII digit
    // Total: 1 + 8 + 2 + 1 = 12 bytes
    await sendCommand('E' + electrodes + ampStr + runStopChar);
    
    console.log(`Stimulation command sent: E${electrodes}${ampStr}${runStopChar} (Electrodes: ${electrode1},${electrode2} | Amplitude: ${amplitude}mA | ${runStop ? 'Go' : 'Stop'})`);
  };

  const initializeImpedance = async (electrodes: number[]) => {
    // Command G: 16 bytes total, electrodes as ASCII characters
    // For 9 electrodes (0-8), we send them as ASCII and then use 'P' (0x50) as terminator
    // Remaining bytes filled with 'P' or higher to ignore
    
    const commandBytes: string[] = [];
    
    // Add valid electrodes (up to 9)
    for (let i = 0; i < electrodes.length && i < 9; i++) {
      const electrode = electrodes[i];
      if (electrode < 0 || electrode > 31) {
        console.error(`Electrode ${electrode} out of range (0-31)`);
        return;
      }
      // Convert to ASCII: 0x30 + electrode number
      commandBytes.push(String.fromCharCode(0x30 + electrode));
    }
    
    // Fill remaining slots with 'P' (0x50) to mark end and pad to 16 bytes
    while (commandBytes.length < 16) {
      commandBytes.push('P');
    }
    
    // Send 'G' followed by the 16 electrode bytes
    const fullCommand = 'G' + commandBytes.join('');
    await sendCommand(fullCommand);
    console.log('Impedance initialization sent:', fullCommand);
  };

  const measureImpedance = async () => {
    // Send 'g' command to start contact scan
    // Data will accumulate across measurements until manually cleared
    await sendCommand('g');
    console.log('Impedance measurement started (g command sent)');
    
    // Note: Impedance data will be received via handleIncomingData
    // and captured as text responses, then added to impedanceData state
  };

  const clearImpedanceData = () => {
    setImpedanceData([]);
  };

  // Drain pending pairs into React state at a controlled rate to throttle
  // UI updates and reduce rAF/reconciliation pressure.
  useEffect(() => {
    let mounted = true;

    const appendChunkToState = (chunk: Array<{ s1: BluetoothSample; s2: BluetoothSample }>) => {
      if (!chunk || chunk.length === 0) return;
      setImuData(prev => {
        const out1 = prev.imu1_changes.slice();
        const out2 = prev.imu2_changes.slice();

        let last1 = out1.length ? out1[out1.length - 1] : null;
        let last2 = out2.length ? out2[out2.length - 1] : null;

        for (const p of chunk) {
          const s1 = p.s1;
          const s2 = p.s2;
          if (
            last1 && last2 &&
            last1.ts === s1.ts && last2.ts === s2.ts &&
            last1.value === s1.value && last2.value === s2.value
          ) {
            continue;
          }
          out1.push(s1);
          out2.push(s2);
          last1 = s1;
          last2 = s2;
        }

        return { imu1_changes: out1, imu2_changes: out2 };
      });
    };

    const chunkedDrain = () => {
      if (!mounted) return;
      if (drainingRef.current) return; // avoid overlapping drains
      if (pairsRef.current.length === 0) return;

      drainingRef.current = true;
      // Determine total to process this tick (bounded)
      const total = Math.min(pairsRef.current.length, MAX_DRAIN_PER_TICK);
      let processed = 0;

      const processNextChunk = () => {
        if (!mounted) {
          drainingRef.current = false;
          return;
        }

        if (processed >= total) {
          drainingRef.current = false;
          return;
        }

        const toTake = Math.min(DRAIN_CHUNK_SIZE, total - processed);
        const chunk = pairsRef.current.splice(0, toTake);
        processed += chunk.length;

        try {
          appendChunkToState(chunk);
        } catch (e) {
          // swallow chunk errors but keep draining
        }

        // If more chunks remain to reach 'total', yield to the event loop
        if (processed < total) {
          setTimeout(processNextChunk, 0);
        } else {
          drainingRef.current = false;
        }
      };

      // Start the chunked processing
      setTimeout(processNextChunk, 0);
    };

    const id = setInterval(chunkedDrain, DRAIN_MS);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  // (Spike/burst forensic log removed; no exported helpers.)

  return (
    <BluetoothContext.Provider value={{
      connect,
      disconnect,
      isConnected,
      sendCommand,
      stimulate,
      imuData,
      startIMU,
      stopIMU,
      clearIMU,
      lastResponse,
      initializeImpedance,
      measureImpedance,
      impedanceData,
      clearImpedanceData,
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