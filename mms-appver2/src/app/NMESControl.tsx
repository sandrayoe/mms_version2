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
  const BIN_MS = 0;
  // NOTE: previously we clipped aggregated/charted values to 1000 to reduce
  // visual jitter. Per request, do not clip values here so originals are
  // preserved for display and recording.

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
  const [isPausedRecording, setIsPausedRecording] = useState(false);
  const isPausedRecordingRef = useRef<boolean>(isPausedRecording);
  const recordedRef = useRef<{ sensor1: { time: number; sensorValue: number }[]; sensor2: { time: number; sensorValue: number }[] }>({ sensor1: [], sensor2: [] });
  // Aggregated (chart) rows stored alongside raw recordings so CSV can reproduce chart
  // Each aggregated row may be flagged as a spike (display suppressed) via `spike`.
  const recordedAggRef = useRef<{ sensor1: { time: number; sensorValue: number; count: number; min: number; max: number; spike?: boolean }[]; sensor2: { time: number; sensorValue: number; count: number; min: number; max: number; spike?: boolean }[] }>({ sensor1: [], sensor2: [] });
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  type Marker = { time: number; type: "start" | "stop" | "pause" | "resume" };
  const [markers, setMarkers] = useState<Marker[]>([]);

  // User inputs for file naming and parameters
  const [frequency, setFrequency] = useState<string>("");
  const [level, setLevel] = useState<string>("");
  const [intensity, setIntensity] = useState<string>("");
  const [motorPoints, setMotorPoints] = useState<string>("");
  const [position, setPosition] = useState<string>("");
  const [pvv1, setPvv1] = useState<string>("");
  const [pvv2, setPvv2] = useState<string>("");
  const [pvv3, setPvv3] = useState<string>("");
  const [modifyMode, setModifyMode] = useState<boolean>(false);
  // New inputs for saving metadata
  const [patientName, setPatientName] = useState<string>("");
  const [sensorName, setSensorName] = useState<string>("");
  // whether the user has submitted input parameters (required fields) before recording
  const [paramsSubmitted, setParamsSubmitted] = useState<boolean>(false);
  // Parameter snapshots recorded at times so CSV rows can reflect values that change mid-recording
  const paramSnapshotsRef = useRef<Array<{ time: number; params: Record<string, string> }>>([]);

  // Helper to append a parameter snapshot (keeps chronological order)
  const pushParamSnapshot = (time: number, params: Record<string,string>) => {
    const arr = paramSnapshotsRef.current;
    // avoid duplicate consecutive identical snapshots
    if (arr.length) {
      const last = arr[arr.length-1].params;
      const same = Object.keys(params).every(k => (last[k]||'') === (params[k]||''));
      if (same) return;
    }
    arr.push({ time, params });
  };

  // Visual cue for last applied snapshot
  const [lastAppliedTime, setLastAppliedTime] = useState<number | null>(null);
  const [showApplied, setShowApplied] = useState(false);

  // Manual snapshot application: user presses "Modify" to record parameter changes into snapshots
  const handleApplyModify = () => {
    // Validate required fields before applying
    const requiredChecks: Array<{ key: string; label: string; value: string }> = [
      { key: 'frequency', label: 'Frequency', value: frequency },
      { key: 'motorPoints', label: 'Motor points', value: motorPoints },
      { key: 'position', label: 'Position', value: position },
      { key: 'pvv1', label: 'PVV1', value: pvv1 },
      { key: 'pvv2', label: 'PVV2', value: pvv2 },
      { key: 'pvv3', label: 'PVV3', value: pvv3 },
    ];

    const missing = requiredChecks.filter((r) => !r.value || r.value.trim() === '').map((r) => r.label);
    if (missing.length) {
      // show a clear alert and avoid saving
      window.alert(`Please fill the required fields before applying: ${missing.join(', ')}`);
      return;
    }

    if (!isRecording) {
      // If not recording, still record snapshot at time 0 so future saves may use it
      const t = 0;
      pushParamSnapshot(t, {
        frequency: frequency || 'N/A',
        level: level || 'N/A',
        intensity: intensity || 'N/A',
        motorPoints: motorPoints || 'N/A',
        position: position || 'N/A',
        pvv1: pvv1 || 'N/A',
        pvv2: pvv2 || 'N/A',
        pvv3: pvv3 || 'N/A',
      });
      // mark submitted since user explicitly applied/submitted parameters
      setParamsSubmitted(true);
      setLastAppliedTime(t);
      setShowApplied(true);
      setTimeout(() => setShowApplied(false), 1500);
      window.alert('Input parameters saved.');
      return;
    }

    // Determine the latest recording time. Prefer the actual recorded data timestamps
    // (recordedRef) so snapshots align with what is written to CSV. Fall back to the
    // displayed sensor arrays if the recorded buffers are not yet populated.
    let latestTime = 0;
    try {
      const rec1 = recordedRef.current.sensor1;
      const rec2 = recordedRef.current.sensor2;
      if (rec1 && rec1.length) {
        latestTime = rec1[rec1.length - 1].time;
      } else if (rec2 && rec2.length) {
        latestTime = rec2[rec2.length - 1].time;
      } else if (sensor1Data.length) {
        latestTime = sensor1Data[sensor1Data.length - 1].time;
      } else if (sensor2Data.length) {
        latestTime = sensor2Data[sensor2Data.length - 1].time;
      } else {
        latestTime = 0;
      }
    } catch (e) {
      latestTime = sensor1Data.length ? sensor1Data[sensor1Data.length - 1].time : (sensor2Data.length ? sensor2Data[sensor2Data.length - 1].time : 0);
    }
    const ok = window.confirm('Apply current parameters to the recording at current time?');
    if (!ok) return;
    pushParamSnapshot(latestTime, {
      frequency: frequency || 'N/A',
      level: level || 'N/A',
      intensity: intensity || 'N/A',
      motorPoints: motorPoints || 'N/A',
      position: position || 'N/A',
      pvv1: pvv1 || 'N/A',
      pvv2: pvv2 || 'N/A',
      pvv3: pvv3 || 'N/A',
    });
    setParamsSubmitted(true);
    setLastAppliedTime(latestTime);
    setShowApplied(true);
    setTimeout(() => setShowApplied(false), 1500);
  };
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

  // Keep a ref in sync with the pause state so the interval closure sees updates
  useEffect(() => {
    isPausedRecordingRef.current = isPausedRecording;
  }, [isPausedRecording]);

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

      // Binning with aggregate stats: returns avg time/value plus count/min/max for CSV
      const binAndAggregate = (samples: { time: number; sensorValue: number }[], binMs: number) => {
        if (!samples || samples.length === 0) return [] as { time: number; sensorValue: number; count: number; min: number; max: number }[];
        if (!binMs || binMs <= 0) {
          return samples.map((s) => ({ time: s.time, sensorValue: s.sensorValue, count: 1, min: s.sensorValue, max: s.sensorValue }));
        }
        const map = new Map<number, { sumVal: number; sumTime: number; count: number; min: number; max: number }>();
        for (const s of samples) {
          const key = Math.floor((s.time * 1000) / binMs);
          const cur = map.get(key) ?? { sumVal: 0, sumTime: 0, count: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
          cur.sumVal += s.sensorValue;
          cur.sumTime += s.time;
          cur.count += 1;
          cur.min = Math.min(cur.min, s.sensorValue);
          cur.max = Math.max(cur.max, s.sensorValue);
          map.set(key, cur);
        }
        const keys = Array.from(map.keys()).sort((a, b) => a - b);
        const out: { time: number; sensorValue: number; count: number; min: number; max: number }[] = [];
        for (const k of keys) {
          const v = map.get(k)!;
          out.push({ time: v.sumTime / v.count, sensorValue: v.sumVal / v.count, count: v.count, min: v.min, max: v.max });
        }
        return out;
      };

  const toAppend1 = BIN_MS > 0 ? binAndAggregate(toAppend1Raw, BIN_MS) : binAndAggregate(toAppend1Raw, BIN_MS);
  const toAppend2 = BIN_MS > 0 ? binAndAggregate(toAppend2Raw, BIN_MS) : binAndAggregate(toAppend2Raw, BIN_MS);

  appendedTotal = (toAppend1.length + toAppend2.length);
      appendedPerTimeStep = Math.max(toAppend1.length, toAppend2.length);

      // Helper clampAppend is defined at component scope (see below) and will be used by the flush loop.

      // Enqueue aggregated points for chart flush, and store aggregated metadata for CSV
      if (toAppend1.length) {
        // Prepare display values without clipping so original aggregated values
        // are preserved in the UI and recordings.
        const display1 = toAppend1.map(p => ({ time: p.time, sensorValue: p.sensorValue }));
        queuedS1Ref.current.push(...display1);
        // Append raw samples (pre-binning) to recorded raw buffer so CSV keeps full fidelity
        if (isRecording && !isPausedRecordingRef.current && toAppend1Raw.length) {
          recordedRef.current.sensor1.push(...toAppend1Raw.map(p => ({ time: p.time, sensorValue: p.sensorValue })));
        }
        // Also save aggregated rows (original values) so CSV reproduces chart if desired
        if (isRecording && !isPausedRecordingRef.current) {
          recordedAggRef.current.sensor1.push(...toAppend1.map(p => ({ time: p.time, sensorValue: p.sensorValue, count: p.count, min: p.min, max: p.max })));
        }
      }
      if (toAppend2.length) {
        const display2 = toAppend2.map(p => ({ time: p.time, sensorValue: p.sensorValue }));
        queuedS2Ref.current.push(...display2);
        if (isRecording && !isPausedRecordingRef.current && toAppend2Raw.length) {
          recordedRef.current.sensor2.push(...toAppend2Raw.map(p => ({ time: p.time, sensorValue: p.sensorValue })));
        }
        if (isRecording && !isPausedRecordingRef.current) {
          recordedAggRef.current.sensor2.push(...toAppend2.map(p => ({ time: p.time, sensorValue: p.sensorValue, count: p.count, min: p.min, max: p.max })));
        }
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
  recordedAggRef.current = { sensor1: [], sensor2: [] };
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
  recordedAggRef.current = { sensor1: [], sensor2: [] };
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
    // Validate required input parameters before starting recording. If missing,
    // show a popup to remind the user to fill them.
    const requiredChecks: Array<{ key: string; label: string; value: string }> = [
      { key: 'frequency', label: 'Frequency', value: frequency },
      { key: 'motorPoints', label: 'Motor points', value: motorPoints },
      { key: 'position', label: 'Position', value: position },
      { key: 'pvv1', label: 'PVV1', value: pvv1 },
      { key: 'pvv2', label: 'PVV2', value: pvv2 },
      { key: 'pvv3', label: 'PVV3', value: pvv3 },
    ];
    const missing = requiredChecks.filter((r) => !r.value || r.value.trim() === '').map((r) => r.label);
    if (missing.length) {
      window.alert(`Please fill the required fields before starting recording: ${missing.join(', ')}`);
      return;
    }

  recordedRef.current = { sensor1: [], sensor2: [] };
  recordedAggRef.current = { sensor1: [], sensor2: [] };
    setIsRecording(true);
    setIsPausedRecording(false);
    // add a start marker at the current chart time (fallback to 0)
    const latestTime = sensor1Data.length ? sensor1Data[sensor1Data.length - 1].time : (sensor2Data.length ? sensor2Data[sensor2Data.length - 1].time : 0);
    setMarkers((prev) => [...prev, { time: latestTime, type: "start" }]);
  };

  const handleStopRecording = () => {
    setIsRecording(false);
    setIsPausedRecording(false);
    // add a stop marker at the current chart time (fallback to 0)
    const latestTime = sensor1Data.length ? sensor1Data[sensor1Data.length - 1].time : (sensor2Data.length ? sensor2Data[sensor2Data.length - 1].time : 0);
    setMarkers((prev) => [...prev, { time: latestTime, type: "stop" }]);
  };

  // Combined handler: if not recording, attempt to start (with validation). If recording,
  // toggle pause/resume.
  const handleStartOrTogglePause = () => {
    if (!isRecording) {
      handleStartRecording();
      return;
    }
    // recording is active -> toggle pause/resume
    handleTogglePauseRecording();
  };

  // Toggle pause/resume for recording. When paused, incoming samples are still
  // displayed on the charts but are not appended to the recorded buffers.
  const handleTogglePauseRecording = () => {
    if (!isRecording) return;
    const latestTime = sensor1Data.length ? sensor1Data[sensor1Data.length - 1].time : (sensor2Data.length ? sensor2Data[sensor2Data.length - 1].time : 0);
    const newPaused = !isPausedRecording;
    setIsPausedRecording(newPaused);
    setMarkers((prev) => [...prev, { time: latestTime, type: newPaused ? "pause" : "resume" }]);
  };

  const handleSaveRecording = () => {
    // Merge sensor1 and sensor2 by time and produce CSV with headers: time,sensor1,sensor2,<params...>
    const s1 = recordedRef.current.sensor1 ?? [];
    const s2 = recordedRef.current.sensor2 ?? [];
    // Collect all times (union) and sort
    const timesSet = new Set<number>();
    s1.forEach((p) => timesSet.add(p.time));
    s2.forEach((p) => timesSet.add(p.time));
    const times = Array.from(timesSet).sort((a, b) => a - b);

    // Create maps time->value for quick lookup
    const map1 = new Map(s1.map((p) => [p.time, p.sensorValue] as [number, number]));
    const map2 = new Map(s2.map((p) => [p.time, p.sensorValue] as [number, number]));

    // Prepare parameter snapshots (ensure sorted by time)
    const snaps = (paramSnapshotsRef.current ?? []).slice().sort((a, b) => a.time - b.time);

    // CSV helper to escape fields that may contain commas/quotes/newlines
    const escapeCSV = (v: string) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      if (s.includes('"')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      if (s.includes(',') || s.includes('\n') || s.includes('\r')) {
        return '"' + s + '"';
      }
      return s;
    };

  // Define parameter column order
  const paramCols = ['frequency','level','intensity','motorPoints','position','pvv1','pvv2','pvv3'];
  // Add patient/sensor metadata columns to header
  const metaCols = ['patientName','sensorName'];

  // Build header (include meta columns after sensors)
  let csv = ['time','sensor1','sensor2', ...paramCols, ...metaCols].join(',') + '\n';

    // Use a pointer into snaps because times are sorted ascending
    let snapIdx = 0;
    for (const t of times) {
      // advance snapIdx while next snapshot time <= t
      while (snapIdx + 1 < snaps.length && snaps[snapIdx + 1].time <= t) snapIdx++;
      // If the first snap is after t, we keep snapIdx at 0 only if its time <= t, otherwise there is no snap <= t
      let paramsForRow: Record<string,string> = {};
      if (snaps.length === 0) {
        // no snapshots recorded; use current UI values as best-effort
        paramsForRow = {
          frequency: frequency || 'N/A',
          level: level || 'N/A',
          intensity: intensity || 'N/A',
          motorPoints: motorPoints || 'N/A',
          position: position || 'N/A',
          pvv1: pvv1 || 'N/A',
          pvv2: pvv2 || 'N/A',
          pvv3: pvv3 || 'N/A',
        };
      } else {
        // if the current snapIdx's time is <= t, use it; otherwise use the earliest snap (fallback)
        if (snaps[snapIdx].time <= t) {
          paramsForRow = snaps[snapIdx].params;
        } else {
          paramsForRow = snaps[0].params;
        }
      }

      const v1 = map1.has(t) ? String(map1.get(t)) : '';
      const v2 = map2.has(t) ? String(map2.get(t)) : '';
  const paramVals = paramCols.map(c => escapeCSV(paramsForRow[c] ?? 'N/A'));
  const metaVals = [escapeCSV(patientName || 'N/A'), escapeCSV(sensorName || 'N/A')];
  csv += `${t},${v1},${v2},${paramVals.join(',')},${metaVals.join(',')}\n`;
    }

    // Append markers section so time markers are preserved in the recording file
    if (markers && markers.length) {
      csv += '\nmarkers,type,time\n';
      for (const m of markers) {
        csv += `${m.type},${m.type},${m.time}\n`;
      }
    }

    // Append aggregated (chart) rows so the CSV can reproduce what was displayed
    const agg1 = recordedAggRef.current.sensor1 ?? [];
    const agg2 = recordedAggRef.current.sensor2 ?? [];
    if ((agg1 && agg1.length) || (agg2 && agg2.length)) {
      csv += '\naggregated_sensor1,time,avg,count,min,max,spike\n';
      for (const a of agg1) {
        csv += `${a.time},${a.sensorValue},${a.count},${a.min},${a.max},${a.spike ? '1' : '0'}\n`;
      }
      csv += '\naggregated_sensor2,time,avg,count,min,max,spike\n';
      for (const a of agg2) {
        csv += `${a.time},${a.sensorValue},${a.count},${a.min},${a.max},${a.spike ? '1' : '0'}\n`;
      }
    }

    // Helper to sanitize parts for filenames
    const sanitize = (s: string) => s.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-\.]/g, '');

  const patientPart = patientName ? sanitize(patientName) : 'patientNA';
  const sensorPart = sensorName ? sanitize(sensorName) : 'sensorNA';

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Build user-friendly filename including provided inputs, use compact numeric timestamp (no Z, no colons)
    const d = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
  a.download = `mms_${patientPart}_${sensorPart}_${iso}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Download spike/burst event log exposed by BluetoothContext
  // Spike log export/clear handlers removed per request; spike events remain
  // accessible programmatically via getSpikeEvents() / clearSpikeEvents() if needed.

  // Save validation state (computed each render)
  const hasRecordedData = (recordedRef.current.sensor1.length > 0) || (recordedRef.current.sensor2.length > 0);
  const saveMissingReasons: string[] = [];
  if (!hasRecordedData) saveMissingReasons.push('No recorded sensor data');
  if (!patientName || !patientName.trim()) saveMissingReasons.push('Patient Name is required');
  if (!sensorName || !sensorName.trim()) saveMissingReasons.push('Sensor Name is required');

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
          <>
          <div className={styles.controlBox}>
            <h3>Sensor Control</h3>
            <div className={styles.inputsBlock}>
              {/* Patient name removed - using parameter fields instead */}
                {/* Row 1: Frequency (left) - Level (middle) */}
                <label className={`${styles.inputLabel} ${styles.col1}`}>
                  <span className={styles.labelRow}>Frequency (Hz):<span className={styles.requiredAsterisk}>*</span></span>
                  <input className={`${styles.textInput} ${styles.smallInput}`} value={frequency} onChange={(e) => { setFrequency(e.target.value); setParamsSubmitted(false); }} />
                </label>
                <label className={`${styles.inputLabel} ${styles.col2} ${styles.levelInputWrap}`}>
                  <span className={styles.labelRow}>Level:</span>
                  <input className={`${styles.textInput} ${styles.smallInput}`} value={level} onChange={(e) => setLevel(e.target.value)} />
                </label>

                {/* Row 2: Intensity (left middle) - Motor points (middle/right) */}
                <label className={`${styles.inputLabel} ${styles.col1}`}>
                  <span className={styles.labelRow}>Intensity (mA):</span>
                  <input className={`${styles.textInput} ${styles.smallInput}`} value={intensity} onChange={(e) => setIntensity(e.target.value)} />
                </label>
                <label className={`${styles.inputLabel} ${styles.col2}`}>
                  <span className={styles.labelRow}>Motor points:<span className={styles.requiredAsterisk}>*</span></span>
                  <input className={`${styles.textInput} ${styles.smallInput}`} value={motorPoints} onChange={(e) => { setMotorPoints(e.target.value); setParamsSubmitted(false); }} />
                </label>

                {/* Row 3: Position (left) - PVV1 (middle) */}
                <label className={`${styles.inputLabel} ${styles.col1}`}>
                  <span className={styles.labelRow}>Position:<span className={styles.requiredAsterisk}>*</span></span>
                  <input className={`${styles.textInput} ${styles.smallInput}`} value={position} onChange={(e) => { setPosition(e.target.value); setParamsSubmitted(false); }} />
                </label>
                <label className={`${styles.inputLabel} ${styles.col2}`}>
                  <span className={styles.labelRow}>PVV1:<span className={styles.requiredAsterisk}>*</span></span>
                  <input className={`${styles.textInput} ${styles.smallInput}`} value={pvv1} onChange={(e) => { setPvv1(e.target.value); setParamsSubmitted(false); }} />
                </label>

                {/* Row 4: PVV2 (left) - PVV3 (middle) */}
                <label className={`${styles.inputLabel} ${styles.col1}`}>
                  <span className={styles.labelRow}>PVV2:<span className={styles.requiredAsterisk}>*</span></span>
                  <input className={`${styles.textInput} ${styles.smallInput}`} value={pvv2} onChange={(e) => { setPvv2(e.target.value); setParamsSubmitted(false); }} />
                </label>
                <label className={`${styles.inputLabel} ${styles.col2}`}>
                  <span className={styles.labelRow}>PVV3:<span className={styles.requiredAsterisk}>*</span></span>
                  <input className={`${styles.textInput} ${styles.smallInput}`} value={pvv3} onChange={(e) => { setPvv3(e.target.value); setParamsSubmitted(false); }} />
                </label>
                {/* place the button in the middle column and span rows 2-3 so it sits among the input boxes */}
                <div className={styles.buttonMidCell}>
                  <div className={styles.modifyArea} style={{ width: '100%', maxWidth: 220 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                      <button className={`${styles.button} ${styles.compactButton}`} onClick={handleApplyModify} disabled={!isConnected}>
                        Input Parameters
                      </button>
                      <div aria-live="polite">
                        {showApplied && lastAppliedTime !== null && (
                          <span className={styles.applyBadge}>Applied @ {lastAppliedTime.toFixed(2)}s</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            <div className={styles.controlsRow}>
              <div className={styles.buttonContainer}>
                <button className={styles.button} onClick={handleStartIMU} disabled={!isConnected || isMeasuring}>
                  Start Sensor(s)
                </button>
                <button className={styles.button} onClick={handleStopIMU} disabled={!isConnected || !isMeasuring}>
                  Stop Sensor(s)
                </button>
                <button className={styles.button} onClick={handleStartOrTogglePause} disabled={!isConnected || !isMeasuring}>
                  {!isRecording ? 'Start Recording' : (isPausedRecording ? 'Resume Recording' : 'Pause Recording')}
                </button>
                <button className={styles.button} onClick={handleStopRecording} disabled={!isRecording}>
                  Stop Recording
                </button>
              </div>

              
            </div>
          </div>

          {/* New gray save panel on the right side */}
          <div className={styles.savePanel}>
            <h3 style={{ margin: '0 0 12px 0' }}>Save File Data</h3>
            <label className={styles.inputLabel} style={{ width: '100%', marginBottom: 8 }}>
              <span className={styles.labelRow}>Patient Name:</span>
              <input className={styles.textInput} value={patientName} onChange={(e) => setPatientName(e.target.value)} />
            </label>
            <label className={styles.inputLabel} style={{ width: '100%' }}>
              <span className={styles.labelRow}>Sensor Name:</span>
              <input className={styles.textInput} value={sensorName} onChange={(e) => setSensorName(e.target.value)} />
            </label>
            <div style={{ height: 8 }} />
            {/* Validation messages */}
            {saveMissingReasons.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                {saveMissingReasons.map((m, i) => (
                  <div key={i} className={styles.saveError}>{m}</div>
                ))}
              </div>
            )}
            <button
              className={styles.button}
              onClick={() => {
                handleSaveRecording();
              }}
              disabled={
                isRecording ||
                !hasRecordedData ||
                !patientName.trim() ||
                !sensorName.trim()
              }
            >
              Save Recording
            </button>
            <div style={{ height: 8 }} />
            {/* Spike log download/clear buttons removed per request */}
          </div>
          </>
        )}
      </div>

      {isConnected && (
        <div className={styles.contentContainer}>
          <div className={styles.rightPanel}>
            <div className={styles.chartsGrid}>
              {/* Row 1: Sensor 1 (250) left, Sensor 1 (50) right */}
              <div className={styles.chartContainer}>
                <h3>Sensor 1 Readings (0-{CHART_Y_MAX})</h3>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={sensor1Data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(s) => Number(s).toFixed(1)} />
                    <YAxis domain={[0, CHART_Y_MAX]} tickCount={6} tickFormatter={(v) => String(Math.round(Number(v)))} />
                    <Tooltip labelFormatter={(label) => `${Number(label).toFixed(2)}s`} formatter={(value) => Number(value).toFixed(2)} />
                    <Legend />
                    <Line type="linear" dataKey="sensorValue" stroke="#8884d8" strokeWidth={2} name="Sensor 1" dot={false} isAnimationActive={false} />
                    {markers.map((m, i) => (
                      <ReferenceLine key={`m1-${i}`} x={m.time} stroke={m.type === 'start' ? '#00b050' : '#ff4d4d'} label={m.type} strokeDasharray="3 3" />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className={styles.chartContainer}>
                <h3>Sensor 1 Readings (0-50)</h3>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={sensor1Data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(s) => Number(s).toFixed(1)} />
                    <YAxis domain={[0, 50]} tickCount={6} tickFormatter={(v) => String(Math.round(Number(v)))} />
                    <Tooltip labelFormatter={(label) => `${Number(label).toFixed(2)}s`} formatter={(value) => Number(value).toFixed(2)} />
                    <Legend />
                    <Line type="linear" dataKey="sensorValue" stroke="#8884d8" strokeWidth={2} name="Sensor 1" dot={false} isAnimationActive={false} />
                    {markers.map((m, i) => (
                      <ReferenceLine key={`m1s-${i}`} x={m.time} stroke={m.type === 'start' ? '#00b050' : '#ff4d4d'} label={m.type} strokeDasharray="3 3" />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Row 2: Sensor 2 (250) left, Sensor 2 (50) right */}
              <div className={styles.chartContainer}>
                <h3>Sensor 2 Readings (0-{CHART_Y_MAX})</h3>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={sensor2Data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(s) => Number(s).toFixed(1)} />
                    <YAxis domain={[0, CHART_Y_MAX]} tickCount={6} tickFormatter={(v) => String(Math.round(Number(v)))} />
                    <Tooltip labelFormatter={(label) => `${Number(label).toFixed(2)}s`} formatter={(value) => Number(value).toFixed(2)} />
                    <Legend />
                    <Line type="linear" dataKey="sensorValue" stroke="#82ca9d" strokeWidth={2} name="Sensor 2" dot={false} isAnimationActive={false} />
                    {markers.map((m, i) => (
                      <ReferenceLine key={`m2-${i}`} x={m.time} stroke={m.type === 'start' ? '#00b050' : '#ff4d4d'} label={m.type} strokeDasharray="3 3" />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className={styles.chartContainer}>
                <h3>Sensor 2 Readings (0-50)</h3>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={sensor2Data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(s) => Number(s).toFixed(1)} />
                    <YAxis domain={[0, 50]} tickCount={6} tickFormatter={(v) => String(Math.round(Number(v)))} />
                    <Tooltip labelFormatter={(label) => `${Number(label).toFixed(2)}s`} formatter={(value) => Number(value).toFixed(2)} />
                    <Legend />
                    <Line type="linear" dataKey="sensorValue" stroke="#82ca9d" strokeWidth={2} name="Sensor 2" dot={false} isAnimationActive={false} />
                    {markers.map((m, i) => (
                      <ReferenceLine key={`m2s-${i}`} x={m.time} stroke={m.type === 'start' ? '#00b050' : '#ff4d4d'} label={m.type} strokeDasharray="3 3" />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SensorPanel;





