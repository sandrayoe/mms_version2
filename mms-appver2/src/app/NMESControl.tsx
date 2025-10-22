"use client";

import React, { useState, useEffect, useRef } from "react";
import { useBluetooth } from "./BluetoothContext";
import BluetoothControl from "./BluetoothControl";
import styles from "./NMESControl.module.css";
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ReferenceLine } from "recharts";

const SensorPanel: React.FC = () => {
  const { isConnected, imuData, startIMU, stopIMU, clearIMU } = useBluetooth();

  const [sensor1Data, setSensor1Data] = useState<{ time: number; sensorValue: number }[]>([]);
  const [sensor2Data, setSensor2Data] = useState<{ time: number; sensorValue: number }[]>([]);
  // Number of samples to keep in the displayed chart window (most recent samples)
  const CHART_WINDOW_SIZE = 200;
  // Fixed Y axis maximum for better visual comparison and less jittering
  const CHART_Y_MAX = 250;

  // Bin width in milliseconds for simple time-binning/averaging of incoming samples.
  // Set to 0 to disable binning and keep raw samples. Typical useful values: 5-20 ms.
  const BIN_MS = 20;

  const [isMeasuring, setIsMeasuring] = useState(false);
  const prevImuLenRef = useRef({ s1: 0, s2: 0 });
  const sampleIntervalMs = 20; // assumed device sample interval (20ms -> 50Hz). Adjust if needed.
  const sampleIndexRef = useRef<number>(0);
  const sessionStartRef = useRef<number | null>(null); // performance.now() at first sample

  // Internal queues for raw samples; we will flush these incrementally via rAF
  const queuedS1Ref = useRef<{ time: number; sensorValue: number }[]>([]);
  const queuedS2Ref = useRef<{ time: number; sensorValue: number }[]>([]);
  const flushingRef = useRef(false);
  const FLUSH_PER_FRAME = 8; // number of samples to append per frame per sensor; tune for smoothness

  // Helper to ensure strictly increasing time values when appending new points.
  // Recharts can render odd vertical lines when multiple points share the same x value.
  const EPS_SEC = 0.0005; // 0.5 ms in seconds
  const clampAppend = (prevArr: { time: number; sensorValue: number }[], newPts: { time: number; sensorValue: number }[]) => {
    if (!newPts || newPts.length === 0) return prevArr.slice(-CHART_WINDOW_SIZE);
    const out: { time: number; sensorValue: number }[] = [];
    let lastTime = prevArr.length ? prevArr[prevArr.length - 1].time : -Infinity;
    for (const p of newPts) {
      const copy = { ...p };
      if (!(copy.time > lastTime)) {
        copy.time = lastTime + EPS_SEC;
      }
      lastTime = copy.time;
      out.push(copy);
    }
    return [...prevArr, ...out].slice(-CHART_WINDOW_SIZE);
  };

  // Recording state & storage for later download
  const [isRecording, setIsRecording] = useState(false);
  const recordedRef = useRef<{ sensor1: { time: number; sensorValue: number }[]; sensor2: { time: number; sensorValue: number }[] }>({ sensor1: [], sensor2: [] });
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  type Marker = { time: number; type: "start" | "stop" };
  const [markers, setMarkers] = useState<Marker[]>([]);

  // User inputs for file naming
  const [patientName, setPatientName] = useState<string>("");
  const [frequency, setFrequency] = useState<string>("");
  const [level, setLevel] = useState<string>("");
  // diagnostics removed from UI; use BIN_MS to control displayed smoothing
  // Diagnostics for timing and sample indexing
  const lastTickWallClockRef = useRef<number | null>(null);
  const lastSampleIndexRef = useRef<number>(0);
  const [diag, setDiag] = useState<{
    prevIndex: number;
    newIndex: number;
    appended: number;
    expectedMs: number;
    actualMs: number;
    errorMs: number;
    effectiveHz: number;
  } | null>(null);
  // Keep a ref to the latest imuData provided by context, so we can poll it at a steady interval
  const imuDataRefLocal = useRef(imuData);
  useEffect(() => {
    imuDataRefLocal.current = imuData;
  }, [imuData]);

  // Poll the imuData ref at a coarser interval and batch-append new samples for smoother UI updates.
  // This reduces rendering churn while still providing near-real-time data. We also handle
  // the case where the provider arrays shrink (rolling buffer) by resetting prev indices.
  useEffect(() => {
    if (!isConnected || !isMeasuring) return;

    const tick = () => {
      const tickNow = performance.now();
  const s1 = imuDataRefLocal.current.imu1_changes;
  const s2 = imuDataRefLocal.current.imu2_changes;

      let prevS1 = prevImuLenRef.current.s1;
      let prevS2 = prevImuLenRef.current.s2;

  // If provider arrays have shrunk (due to any slicing elsewhere), reset prev indexes
  // so we don't miss the newly-started slice.
  if (s1.length < prevS1) prevS1 = 0;
  if (s2.length < prevS2) prevS2 = 0;

  const newS1 = s1.length > prevS1 ? s1.slice(prevS1) : [];
  const newS2 = s2.length > prevS2 ? s2.slice(prevS2) : [];

      if (newS1.length === 0 && newS2.length === 0) {
        // update last tick time so actualMs is measured between ticks even when no data
        lastTickWallClockRef.current = tickNow;
        return;
      }

      const prevIndex = sampleIndexRef.current;
      // Prefer provider timestamps if available. We'll compute times in seconds relative
      // to sessionStartRef (first observed sample ts). If no timestamps present (legacy),
      // fall back to sampleIndex timebase.
      let appendedPerTimeStep = 0;
      let appendedTotal = 0;
      let earliestTs: number | null = null;
      let latestTs: number | null = null;


      // Helper to push charts using provider ts. Also compute min/max ts across the batch
      const getMinMaxTs = (arr1: any[], arr2: any[]) => {
        let minTs: number | null = null;
        let maxTs: number | null = null;
        const all = [] as number[];
        if (arr1 && arr1.length) all.push(...arr1.map((s) => s.ts));
        if (arr2 && arr2.length) all.push(...arr2.map((s) => s.ts));
        if (all.length === 0) return { minTs: null, maxTs: null };
        minTs = Math.min(...all);
        maxTs = Math.max(...all);
        return { minTs, maxTs };
      };

      const { minTs, maxTs } = getMinMaxTs(newS1 as any[], newS2 as any[]);

      // If we have provider timestamps, set session start to the earliest sample timestamp
      if (minTs !== null && sessionStartRef.current === null) {
        sessionStartRef.current = minTs;
      }

      const pushWithTs = (samples: any[]) => {
        if (samples.length === 0) return [];
        const sessionStart = sessionStartRef.current ?? minTs ?? tickNow;
        const points = samples.map((s) => ({ time: (s.ts - (sessionStart as number)) / 1000, sensorValue: s.value }));
        return points;
      };

      const toAppend1Raw = pushWithTs(newS1 as any[]);
      const toAppend2Raw = pushWithTs(newS2 as any[]);

      // Simple binning: group samples into BIN_MS millisecond bins and average time/value
      const binAndAverage = (samples: { time: number; sensorValue: number }[], binMs: number) => {
        if (!samples || samples.length === 0) return [] as { time: number; sensorValue: number }[];
        if (!binMs || binMs <= 0) return samples;
        const map = new Map<number, { sumVal: number; sumTime: number; count: number }>();
        for (const s of samples) {
          const key = Math.floor((s.time * 1000) / binMs);
          const cur = map.get(key) ?? { sumVal: 0, sumTime: 0, count: 0 };
          cur.sumVal += s.sensorValue;
          cur.sumTime += s.time;
          cur.count += 1;
          map.set(key, cur);
        }
        const keys = Array.from(map.keys()).sort((a, b) => a - b);
        const out: { time: number; sensorValue: number }[] = [];
        for (const k of keys) {
          const v = map.get(k)!;
          out.push({ time: v.sumTime / v.count, sensorValue: v.sumVal / v.count });
        }
        return out;
      };

      const toAppend1 = BIN_MS > 0 ? binAndAverage(toAppend1Raw, BIN_MS) : toAppend1Raw;
      const toAppend2 = BIN_MS > 0 ? binAndAverage(toAppend2Raw, BIN_MS) : toAppend2Raw;

  appendedTotal = (toAppend1.length + toAppend2.length);
      appendedPerTimeStep = Math.max(toAppend1.length, toAppend2.length);

      // Helper clampAppend is defined at component scope (see below) and will be used by the flush loop.

      // Enqueue raw parsed samples for incremental flush via rAF
      if (toAppend1.length) {
        queuedS1Ref.current.push(...toAppend1.map(p => ({ ...p })));
        if (isRecording) recordedRef.current.sensor1.push(...toAppend1.map(p => ({ ...p })));
      }
      if (toAppend2.length) {
        queuedS2Ref.current.push(...toAppend2.map(p => ({ ...p })));
        if (isRecording) recordedRef.current.sensor2.push(...toAppend2.map(p => ({ ...p })));
      }

      // Start flush loop if not already running
      if (!flushingRef.current) {
        flushingRef.current = true;
        const flush = () => {
          let didWork = false;
          // flush sensor1
          if (queuedS1Ref.current.length) {
            const chunk = queuedS1Ref.current.splice(0, FLUSH_PER_FRAME);
            setSensor1Data((prev) => clampAppend(prev, chunk));
            didWork = true;
          }
          // flush sensor2
          if (queuedS2Ref.current.length) {
            const chunk = queuedS2Ref.current.splice(0, FLUSH_PER_FRAME);
            setSensor2Data((prev) => clampAppend(prev, chunk));
            didWork = true;
          }
          if (didWork) {
            requestAnimationFrame(flush);
          } else {
            flushingRef.current = false;
          }
        };
        requestAnimationFrame(flush);
      }

      // If we used provider timestamps, advance sampleIndex conservatively by appendedPerTimeStep
      sampleIndexRef.current += appendedPerTimeStep;

      setLastUpdate(Date.now());

      const newIndex = sampleIndexRef.current;
      // expected elapsed ms for appended time-steps (we can use provider timestamps if available)
      // Compute expectedMs from provider timestamps when available
      let expectedMs = appendedPerTimeStep * sampleIntervalMs;
      if (minTs !== null && maxTs !== null) {
        expectedMs = maxTs - minTs;
      }
      const lastTick = lastTickWallClockRef.current ?? tickNow;
      const actualMs = Math.max(0, tickNow - lastTick);
      const errorMs = actualMs - expectedMs;
      // effectiveHz: prefer provider time range when available
      const effectiveHz = expectedMs > 0 ? (appendedPerTimeStep / (expectedMs / 1000)) : (actualMs > 0 ? (appendedPerTimeStep / (actualMs / 1000)) : 0);

      // set diagnostic state
      setDiag({ prevIndex, newIndex, appended: appendedTotal, expectedMs, actualMs, errorMs, effectiveHz });

      // diagnostics logging removed from UI; binning is applied above

      lastTickWallClockRef.current = tickNow;

      prevImuLenRef.current.s1 = s1.length;
      prevImuLenRef.current.s2 = s2.length;
    };

  const id = setInterval(tick, 100); // batch every 100 ms
    return () => clearInterval(id);
  }, [isConnected, isMeasuring, isRecording]);

  // Reset graphs and recording if the device disconnects
  useEffect(() => {
    if (!isConnected) {
      // stop any ongoing measurement/recording and clear buffers
      setIsMeasuring(false);
      setIsRecording(false);
      setSensor1Data([]);
      setSensor2Data([]);
      recordedRef.current = { sensor1: [], sensor2: [] };
      prevImuLenRef.current = { s1: 0, s2: 0 };
      sampleIndexRef.current = 0;
    }
  }, [isConnected]);

  const handleStartIMU = () => {
    // Refresh/clear graphs and previous IMU indices when starting a new measurement
    setSensor1Data([]);
    setSensor2Data([]);
    // Prevent appending old buffered imuData that arrived before Start was pressed
    // Clear provider buffer so we start fresh
    clearIMU();
    prevImuLenRef.current = { s1: 0, s2: 0 };
    recordedRef.current = { sensor1: [], sensor2: [] };
    setIsRecording(false);
    sampleIndexRef.current = 0;
    // Ensure session-relative time restarts at 0 for new measurement
    sessionStartRef.current = null;
    setIsMeasuring(true);
    startIMU();
    // clear markers when starting a fresh measurement
    setMarkers([]);
  };

  const handleStopIMU = () => {
    setIsMeasuring(false);
    stopIMU();
  };

  // Recording controls
  const handleStartRecording = () => {
    recordedRef.current = { sensor1: [], sensor2: [] };
    setIsRecording(true);
    // add a start marker at the current chart time (fallback to 0)
    const latestTime = sensor1Data.length ? sensor1Data[sensor1Data.length - 1].time : (sensor2Data.length ? sensor2Data[sensor2Data.length - 1].time : 0);
    setMarkers((prev) => [...prev, { time: latestTime, type: "start" }]);
  };

  const handleStopRecording = () => {
    setIsRecording(false);
    // add a stop marker at the current chart time (fallback to 0)
    const latestTime = sensor1Data.length ? sensor1Data[sensor1Data.length - 1].time : (sensor2Data.length ? sensor2Data[sensor2Data.length - 1].time : 0);
    setMarkers((prev) => [...prev, { time: latestTime, type: "stop" }]);
  };

  const handleSaveRecording = () => {
    // Merge sensor1 and sensor2 by time and produce CSV with headers: time,sensor1,sensor2
    const s1 = recordedRef.current.sensor1 ?? [];
    const s2 = recordedRef.current.sensor2 ?? [];
    // Collect all times (union) and sort
    const timesSet = new Set<number>();
    s1.forEach(p => timesSet.add(p.time));
    s2.forEach(p => timesSet.add(p.time));
    const times = Array.from(timesSet).sort((a,b) => a - b);

    // Create maps time->value for quick lookup
    const map1 = new Map(s1.map(p => [p.time, p.sensorValue] as [number, number]));
    const map2 = new Map(s2.map(p => [p.time, p.sensorValue] as [number, number]));

    let csv = 'time,sensor1,sensor2\n';
    for (const t of times) {
      const v1 = map1.has(t) ? String(map1.get(t)) : '';
      const v2 = map2.has(t) ? String(map2.get(t)) : '';
      csv += `${t},${v1},${v2}\n`;
    }

    // Append markers section so time markers are preserved in the recording file
    if (markers && markers.length) {
      csv += '\nmarkers,type,time\n';
      for (const m of markers) {
        csv += `${m.type},${m.type},${m.time}\n`;
      }
    }

    // Helper to sanitize parts for filenames
    const sanitize = (s: string) => s.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-\.]/g, '');

    const patientPart = patientName ? sanitize(patientName) : 'unknown';
    const freqPart = frequency ? `${sanitize(frequency)}Hz` : 'freqNA';
    const levelPart = level ? `${sanitize(level)}` : 'levelNA';

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
  // Build user-friendly filename including provided inputs, use compact numeric timestamp (no Z, no colons)
  // Example: 2025-10-22T19-10-31-544
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
  a.download = `mms_${patientPart}_${freqPart}_${levelPart}_${iso}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <img src="/mms_logo_2.png" className={styles.logo} />
        <h1 className={styles.heading}>MMS - Sensor Readings</h1>
      </div>
      <div style={{ height: 8 }} />
      <div className={styles.topContainer}>
        <div className={styles.controlCard}>
          <h3>Bluetooth</h3>
          <div className={styles.buttonContainer}>
            <BluetoothControl />
          </div>
        </div>

        {isConnected && (
          <div className={styles.controlBox}>
            <h3>Sensor Control</h3>
            <div className={styles.inputsBlock}>
              <label className={styles.inputLabel}>
                Patient name:<span className={styles.requiredAsterisk}>*</span>
                <input className={styles.textInput} value={patientName} onChange={(e) => setPatientName(e.target.value)} />
              </label>
              {/* explanatory note removed per request */}

              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label className={styles.inputLabel} style={{ flex: 1 }}>
                  Frequency (Hz):<span className={styles.requiredAsterisk}>*</span>
                  <input className={`${styles.textInput} ${styles.smallInput}`} value={frequency} onChange={(e) => setFrequency(e.target.value)} />
                </label>
                <label className={styles.inputLabel} style={{ flex: 1 }}>
                  Level:<span className={styles.requiredAsterisk}>*</span>
                  <input className={`${styles.textInput} ${styles.smallInput}`} value={level} onChange={(e) => setLevel(e.target.value)} />
                </label>
              </div>
            </div>
            <div className={styles.buttonContainer}>
              <button className={styles.button} onClick={handleStartIMU} disabled={!isConnected || isMeasuring}>
                Start Sensor(s)
              </button>
              <button className={styles.button} onClick={handleStopIMU} disabled={!isConnected || !isMeasuring}>
                Stop Sensor(s)
              </button>
              <button className={styles.button} onClick={handleStartRecording} disabled={!isConnected || !isMeasuring || isRecording}>
                Start Recording
              </button>
              <button className={styles.button} onClick={handleStopRecording} disabled={!isRecording}>
                Stop Recording
              </button>
              <button
                className={styles.button}
                onClick={() => {
                  const emptyFields: string[] = [];
                  if (!patientName || patientName.trim() === '') emptyFields.push('Patient name');
                  if (!frequency || frequency.trim() === '') emptyFields.push('Frequency');
                  if (!level || level.trim() === '') emptyFields.push('Level');

                  if (emptyFields.length) {
                    const list = emptyFields.join(', ');
                    const ok = window.confirm(`The following fields are empty: ${list}. Are you sure you want to save?`);
                    if (!ok) return;
                  }
                  handleSaveRecording();
                }}
                disabled={isRecording || (recordedRef.current.sensor1.length===0 && recordedRef.current.sensor2.length===0)}
              >
                Save Recording
              </button>
            </div>
          </div>
        )}
      </div>

      {isConnected && (
        <div className={styles.contentContainer}>
          <div className={styles.rightPanel}>
            <div className={styles.chartContainer}>
                <h3>Sensor 1 Readings </h3>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={sensor1Data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="time"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(s) => Number(s).toFixed(1)}
                    />
                    <YAxis domain={[0, CHART_Y_MAX]} tickCount={6} />
                    <Tooltip labelFormatter={(label) => `${Number(label).toFixed(2)}s`} />
                    <Legend />
                    <Line type="linear" dataKey="sensorValue" stroke="#8884d8" strokeWidth={2} name="Sensor 1" dot={false} isAnimationActive={false} />
                      {markers.map((m, i) => (
                        <ReferenceLine key={`m1-${i}`} x={m.time} stroke={m.type === 'start' ? '#00b050' : '#ff4d4d'} label={m.type} strokeDasharray="3 3" />
                      ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className={styles.chartContainer}>
                <h3>Sensor 2 Readings </h3>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={sensor2Data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="time"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(s) => Number(s).toFixed(1)}
                    />
                    <YAxis domain={[0, CHART_Y_MAX]} tickCount={6} />
                    <Tooltip labelFormatter={(label) => `${Number(label).toFixed(2)}s`} />
                    <Legend />
                    <Line type="linear" dataKey="sensorValue" stroke="#82ca9d" strokeWidth={2} name="Sensor 2" dot={false} isAnimationActive={false} />
                    {markers.map((m, i) => (
                      <ReferenceLine key={`m2-${i}`} x={m.time} stroke={m.type === 'start' ? '#00b050' : '#ff4d4d'} label={m.type} strokeDasharray="3 3" />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SensorPanel;





