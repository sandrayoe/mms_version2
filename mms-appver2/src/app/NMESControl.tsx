"use client";

import React, { useState, useEffect, useRef } from "react";
import { useBluetooth } from "./BluetoothContext";
import BluetoothControl from "./BluetoothControl";
import styles from "./NMESControl.module.css";
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ReferenceLine } from "recharts";

const SensorPanel: React.FC = () => {
  const { isConnected, imuData, startIMU, stopIMU, clearIMU, stimulate, sendCommand, lastResponse, initializeImpedance, measureImpedance, impedanceData, clearImpedanceData } = useBluetooth();

  // Keep a ref to the latest lastResponse so async handlers can await expected replies
  const lastResponseRef = useRef<string | null>(lastResponse);
  useEffect(() => { lastResponseRef.current = lastResponse; }, [lastResponse]);
  const [sensor1Data, setSensor1Data] = useState<{ time: number; sensorValue: number }[]>([]);
  const [sensor2Data, setSensor2Data] = useState<{ time: number; sensorValue: number }[]>([]);
  // Number of samples to keep in the displayed chart window (most recent samples)
  const CHART_WINDOW_SIZE = 200;

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
  const sessionStartRef = useRef<number | null>(null); // provider timestamp at first sample
  const sessionWallClockStartRef = useRef<number | null>(null); // Date.now() when session starts

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
  type Marker = { time: number; type: "start" | "stop" | "pause" | "resume" };
  const [markers, setMarkers] = useState<Marker[]>([]);

  // User inputs for file naming and parameters
  const [frequency, setFrequency] = useState<string>("");
  const [rampUp, setRampUp] = useState<string>("");
  const [rampDown, setRampDown] = useState<string>("");
  const [offTime, setOffTime] = useState<string>("");
  // Electrode selection for stimulation
  const [electrode1, setElectrode1] = useState<string>("1");
  const [electrode2, setElectrode2] = useState<string>("9");
  const [amplitude, setAmplitude] = useState<string>("5");
  const [isStimulating, setIsStimulating] = useState<boolean>(false);
  const [isContinuousMeasuring, setIsContinuousMeasuring] = useState<boolean>(false);
  const continuousMeasurementTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [stimulationStartTimestamp, setStimulationStartTimestamp] = useState<string>("");
  const [secondGTimestamp, setSecondGTimestamp] = useState<string>("");
  // New inputs for saving metadata
  const [patientName, setPatientName] = useState<string>("");
  const [sensorName, setSensorName] = useState<string>("");
  // Parameter snapshots recorded at times so CSV rows can reflect values that change mid-recording
  const paramSnapshotsRef = useRef<Array<{ time: number; params: Record<string, string> }>>([]);

  // CSV helper to escape fields that may contain commas/quotes/newlines (component scope)
  const escapeCSV = (v: any) => {
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

  // Manual snapshot application: user presses "Modify" to record parameter changes into snapshots
  const handleApplyModify = async () => {
    // Send commands to device
    try {
      // Frequency command: 'f' + 2 ASCII digits (e.g., 'f25' for 25 Hz)
      if (frequency) {
        const freqNum = parseInt(frequency);
        if (isNaN(freqNum) || freqNum < 15 || freqNum > 50) {
          window.alert('Frequency must be between 15 and 50 Hz');
          return;
        }
        await sendCommand('f' + String(freqNum).padStart(2, '0'));
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait for response
      }
      if (rampUp) {
        await sendCommand('r' + rampUp);
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait for response
      }
      if (rampDown) {
        await sendCommand('R' + rampDown);
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait for response
      }
      // OFF-TIME command: 'O' + 2 ASCII digits in deciseconds (e.g., 'O10' for 1.0 seconds)
      if (offTime) {
        const offTimeNum = parseInt(offTime);
        if (isNaN(offTimeNum) || offTimeNum < 0 || offTimeNum > 99) {
          window.alert('OFF-TIME must be between 0 and 99 deciseconds (0-9.9 seconds)');
          return;
        }
        await sendCommand('O' + String(offTimeNum).padStart(2, '0'));
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait for response
      }
      await sendCommand('s');
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait for s-ok response
    } catch (err) {
      console.error('Failed to send parameters:', err);
      window.alert('Failed to send parameters to device');
      return;
    }

    if (!isRecording) {
      // If not recording, still record snapshot at time 0 so future saves may use it
      const t = 0;
      pushParamSnapshot(t, {
        frequency: frequency || 'N/A',
        rampUp: rampUp || 'N/A',
        rampDown: rampDown || 'N/A',
        offTime: offTime || 'N/A',
        electrode1: electrode1 || 'N/A',
        electrode2: electrode2 || 'N/A',
      });
      window.alert('Input parameters sent. s-ok expected from device.');
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
      rampUp: rampUp || 'N/A',
      rampDown: rampDown || 'N/A',
      offTime: offTime || 'N/A',
      electrode1: electrode1 || 'N/A',
      electrode2: electrode2 || 'N/A',
    });
  };
  // diagnostics removed from UI; use BIN_MS to control displayed smoothing
  const lastTickWallClockRef = useRef<number | null>(null);
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
        sessionWallClockStartRef.current = Date.now(); // Capture actual wall clock time
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
      }
      if (toAppend2.length) {
        const display2 = toAppend2.map(p => ({ time: p.time, sensorValue: p.sensorValue }));
        queuedS2Ref.current.push(...display2);
        if (isRecording && !isPausedRecordingRef.current && toAppend2Raw.length) {
          recordedRef.current.sensor2.push(...toAppend2Raw.map(p => ({ time: p.time, sensorValue: p.sensorValue })));
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
    sessionWallClockStartRef.current = null;
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

  const handleStimulate = async () => {
    const e1 = parseInt(electrode1);
    const e2 = parseInt(electrode2);
    const amp = parseInt(amplitude);
    
    if (isNaN(e1) || isNaN(e2) || isNaN(amp)) {
      window.alert('Please enter valid numbers for electrodes and amplitude');
      return;
    }
    
    const newState = !isStimulating;
    setIsStimulating(newState);
    // Subtract 1 from electrode numbers: user input 1-32 maps to device 0-31
    await stimulate(e1 - 1, e2 - 1, amp, newState);
  };

  const handleInitializeImpedance = async () => {
    // Initialize with electrodes 0-8 (9 electrodes total)
    const electrodes = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    await initializeImpedance(electrodes);
    // Device will respond with G-ok, shown in lastResponse
  };

  const handleMeasureImpedance = async () => {
    await measureImpedance();
  };

  const handleContinuousMeasurement = async () => {
    // New flow: send 'LXX' where XX is amplitude (2 ASCII digits), wait for 'L-ok', then send 'h'
    const amp = parseInt(amplitude, 10);
    if (isNaN(amp) || amp < 0 || amp > 120) {
      window.alert('Please enter a valid amplitude (0-120)');
      return;
    }

    setIsContinuousMeasuring(true);

    // Helper to wait for an expected substring in lastResponse with timeout
    const waitForResponse = (expected: string, timeoutMs = 5000) => new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const cur = lastResponseRef.current;
        if (cur && cur.includes(expected)) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('Response timeout'));
        setTimeout(check, 150);
      };
      check();
    });

    try {
      const ampStr = String(amp).padStart(2, '0');
      console.log('[Continuous] Sending L command with amplitude:', ampStr);
      await sendCommand('L' + ampStr);

      // Wait for device to acknowledge with 'L-ok'
      try {
        await waitForResponse('L-ok', 8000);
        console.log('[Continuous] Received L-ok, requesting impedance data (h)');
        await sendCommand('h');
      } catch (err) {
        console.error('Did not receive L-ok:', err);
        window.alert('Device did not acknowledge L command (no L-ok)');
      }
    } catch (err) {
      console.error('Continuous measurement failed:', err);
    } finally {
      setIsContinuousMeasuring(false);
    }
  };

  // Cleanup continuous measurement on unmount
  useEffect(() => {
    return () => {
      if (continuousMeasurementTimerRef.current) {
        clearInterval(continuousMeasurementTimerRef.current as unknown as number);
      }
    };
  }, []);

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

    // CSV helper moved to component scope

  // Define parameter column order
  const paramCols = ['frequency','amplitude','electrode1','electrode2'];
  // Add patient/sensor metadata columns to header
  const metaCols = ['patientName','sensorName'];

  // Build header (relative time first to avoid confusion: relative_time_s, sensor1, sensor2, params, metadata)
  let csv = ['relative_time_s','sensor1','sensor2', ...paramCols, ...metaCols].join(',') + '\n';

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
          amplitude: amplitude || 'N/A',
          electrode1: electrode1 || 'N/A',
          electrode2: electrode2 || 'N/A'
        };
      } else {
        // if the current snapIdx's time is <= t, use it; otherwise use the earliest snap (fallback)
        if (snaps[snapIdx].time <= t) {
          paramsForRow = snaps[snapIdx].params;
        } else {
          paramsForRow = snaps[0].params;
        }
      }
      // No software absolute timestamps: write sensor values and relative time only
      const v1 = map1.has(t) ? String(map1.get(t)) : '';
      const v2 = map2.has(t) ? String(map2.get(t)) : '';
      const paramVals = paramCols.map(c => escapeCSV(paramsForRow[c] ?? 'N/A'));
      const metaVals = [escapeCSV(patientName || 'N/A'), escapeCSV(sensorName || 'N/A')];
      // Escape all fields and put relative time first
      const rowFields = [escapeCSV(String(t)), escapeCSV(v1), escapeCSV(v2), ...paramVals, ...metaVals];
      csv += rowFields.join(',') + '\n';
    }

    // Append markers section so time markers are preserved (no software timestamps)
    if (markers && markers.length) {
      // Add a small marker section header for clarity
      csv += '\n# Markers:type,type,relative_time_s\n';
      for (const m of markers) {
        csv += [escapeCSV(m.type), escapeCSV(m.type), escapeCSV(String(m.time))].join(',') + '\n';
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
    // Build user-friendly filename with ISO 8601 UTC+1 timestamp
    const fileDate = new Date(Date.now() + 60 * 60 * 1000);
    const year = fileDate.getUTCFullYear();
    const month = String(fileDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(fileDate.getUTCDate()).padStart(2, '0');
    const hours = String(fileDate.getUTCHours()).padStart(2, '0');
    const minutes = String(fileDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(fileDate.getUTCSeconds()).padStart(2, '0');
    const milliseconds = String(fileDate.getUTCMilliseconds()).padStart(3, '0');
    const utcPlus1Timestamp = `${year}-${month}-${day}T${hours}-${minutes}-${seconds}-${milliseconds}+01-00`;
  a.download = `mms_${patientPart}_${sensorPart}_${utcPlus1Timestamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleSaveImpedance = () => {
    // Save raw 'h' command output directly to CSV file
    if (!impedanceData || impedanceData.length === 0) {
      window.alert('No impedance measurements to save');
      return;
    }

    // Write raw h command data directly - each line from the device should be in CSV format
    // Expected format from device 'h' command: timestamp_ticks,electrode1,electrode2
    let csv = 'electrode1,electrode2,impedance\n';
    
    // Append all raw impedance data lines from the 'h' command
    // Ensure fields are escaped/quoted so Excel treats them as text and does not auto-format
    for (let i = 0; i < impedanceData.length; i++) {
      const raw = impedanceData[i].data || '';
      const parts = raw.split(',').map(p => escapeCSV(p));
      csv += parts.join(',') + '\n';
    }
    
    // Note: device timestamps are in ticks (50µs per tick). No software timestamps are recorded.
    csv += `\n`;
    csv += `# Note: Device timestamps are in ticks (50µs per tick)\n`;
    csv += `# Conversion: timestamp_ticks × 50µs = time in microseconds since device startup\n`;

    const sanitize = (s: string) => s.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-\.]/g, '');
    const patientPart = patientName ? sanitize(patientName) : 'patientNA';
    const sensorPart = sensorName ? sanitize(sensorName) : 'sensorNA';

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    
    const fileDate = new Date(Date.now() + 60 * 60 * 1000);
    const year = fileDate.getUTCFullYear();
    const month = String(fileDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(fileDate.getUTCDate()).padStart(2, '0');
    const hours = String(fileDate.getUTCHours()).padStart(2, '0');
    const minutes = String(fileDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(fileDate.getUTCSeconds()).padStart(2, '0');
    const milliseconds = String(fileDate.getUTCMilliseconds()).padStart(3, '0');
    const utcPlus1Timestamp = `${year}-${month}-${day}T${hours}-${minutes}-${seconds}-${milliseconds}+01-00`;
    
    a.download = `mms_impedance_${patientPart}_${sensorPart}_${utcPlus1Timestamp}.csv`;
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
  const hasImpedanceData = impedanceData.length > 0;
  const saveMissingReasons: string[] = [];
  if (!hasRecordedData) saveMissingReasons.push('No recorded sensor data');
  if (!patientName || !patientName.trim()) saveMissingReasons.push('Patient Name is required');
  if (!sensorName || !sensorName.trim()) saveMissingReasons.push('Sensor Name is required');

  const impedanceSaveMissingReasons: string[] = [];
  if (!hasImpedanceData) impedanceSaveMissingReasons.push('No impedance measurements');
  if (!patientName || !patientName.trim()) impedanceSaveMissingReasons.push('Patient Name is required');
  if (!sensorName || !sensorName.trim()) impedanceSaveMissingReasons.push('Sensor Name is required');

  // Battery percentage calculation based on voltage
  const [showBatteryTooltip, setShowBatteryTooltip] = useState(false);
  const batteryPercentage = React.useMemo(() => {
    if (!lastResponse) return null;
    // Try to extract numeric value from lastResponse (battery voltage in mV)
    const match = lastResponse.match(/\d+/);
    if (match) {
      const Vbat = parseInt(match[0]);  // Battery voltage in mV
      
      // Battery voltage range (in mV)
      const minVoltage = 3400;  // Minimum operational voltage (3.4V = 3400mV)
      const maxVoltage = 4200;  // Fully charged voltage (4.2V = 4200mV)
      
      // Convert voltage to percentage
      let percentage = ((Vbat - minVoltage) / (maxVoltage - minVoltage)) * 100;
      percentage = Math.min(Math.max(percentage, 0), 100);
      
      return Math.round(percentage);
    }
    return null;
  }, [lastResponse]);

  const handleBatteryClick = async () => {
    if (isConnected) {
      try {
        await sendCommand('V');
        setShowBatteryTooltip(true);
        setTimeout(() => setShowBatteryTooltip(false), 3000); // Auto-hide after 3 seconds
      } catch (err) {
        console.error('Failed to check battery:', err);
      }
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <img src="/mms_logo_2.png" className={styles.logo} />
        <h1 className={styles.heading}>MMS - Sensor Readings</h1>
        <div 
          className={styles.batteryIcon}
          onClick={handleBatteryClick}
          onMouseEnter={() => setShowBatteryTooltip(true)}
          onMouseLeave={() => setShowBatteryTooltip(false)}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="6" width="18" height="12" rx="2" stroke={batteryPercentage !== null && batteryPercentage > 20 ? "#00b050" : batteryPercentage !== null ? "#ff4d4d" : "#666"} strokeWidth="2" />
            <rect x="20" y="9" width="2" height="6" rx="1" fill={batteryPercentage !== null && batteryPercentage > 20 ? "#00b050" : batteryPercentage !== null ? "#ff4d4d" : "#666"} />
            {batteryPercentage !== null && (
              <rect x="4" y="8" width={Math.max(0, (batteryPercentage / 100) * 14)} height="8" rx="1" fill={batteryPercentage > 20 ? "#00b050" : "#ff4d4d"} />
            )}
          </svg>
          {showBatteryTooltip && (
            <div className={styles.batteryTooltip}>
              {batteryPercentage !== null ? `Battery: ${batteryPercentage}%` : 'Click to check battery'}
            </div>
          )}
        </div>
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
              {/* Row 1: Frequency, Ramp-Up, Ramp-Down, OFF-TIME */}
                <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'center', gap: '16px', marginBottom: '8px' }}>
                  <label className={styles.inputLabel}>
                    <span className={styles.labelRow}>Frequency (Hz):</span>
                    <input className={`${styles.textInput} ${styles.smallInput}`} type="number" min="15" max="50" value={frequency} onChange={(e) => { setFrequency(e.target.value);}} />
                  </label>

                  <label className={styles.inputLabel}>
                    <span className={styles.labelRow}>Ramp-Up (ds):</span>
                    <input className={`${styles.textInput} ${styles.smallInput}`} type="number" min="0" value={rampUp} onChange={(e) => { setRampUp(e.target.value); }} />
                  </label>

                  <label className={styles.inputLabel}>
                    <span className={styles.labelRow}>Ramp-Down (ds):</span>
                    <input className={`${styles.textInput} ${styles.smallInput}`} type="number" min="0" value={rampDown} onChange={(e) => { setRampDown(e.target.value);}} />
                  </label>

                  <label className={styles.inputLabel}>
                    <span className={styles.labelRow}>OFF-TIME (ds):</span>
                    <input className={`${styles.textInput} ${styles.smallInput}`} type="number" min="0" max="255" value={offTime} onChange={(e) => { setOffTime(e.target.value);}} />
                  </label>
                </div>

                {/* Row 2: Input Parameters button */}
                <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'center' }}>
                  <div className={styles.modifyArea} style={{ width: '100%', maxWidth: 220 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                      <button className={`${styles.button} ${styles.compactButton}`} onClick={handleApplyModify} disabled={!isConnected}>
                        Input Parameters
                      </button>
                      {lastResponse && (
                        <div style={{ fontSize: '12px', color: lastResponse.includes('ok') ? '#00b050' : '#666', marginTop: '4px' }}>
                          Device: {lastResponse}
                        </div>
                      )}
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

            {/* Stimulation Control Section */}
            <div style={{ marginTop: '16px', padding: '12px', border: '1px solid #ddd', borderRadius: '4px' }}>
              <h4 style={{ marginTop: 0 }}>Electrode Stimulation</h4>
              <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', alignItems: 'flex-end' }}>
                <label className={styles.inputLabel}>
                  <span className={styles.labelRow}>Electrode 1:</span>
                  <input 
                    className={`${styles.textInput} ${styles.smallInput}`} 
                    type="number" 
                    min="1" 
                    max="32" 
                    value={electrode1} 
                    onChange={(e) => setElectrode1(e.target.value)} 
                  />
                </label>
                <label className={styles.inputLabel}>
                  <span className={styles.labelRow}>Electrode 2:</span>
                  <input 
                    className={`${styles.textInput} ${styles.smallInput}`} 
                    type="number" 
                    min="1" 
                    max="32" 
                    value={electrode2} 
                    onChange={(e) => setElectrode2(e.target.value)} 
                  />
                </label>
                <label className={styles.inputLabel}>
                  <span className={styles.labelRow}>Amplitude (mA):</span>
                  <input 
                    className={`${styles.textInput} ${styles.smallInput}`} 
                    type="number" 
                    min="0" 
                    max="120" 
                    value={amplitude} 
                    onChange={(e) => setAmplitude(e.target.value)} 
                  />
                </label>
                <button 
                  className={styles.button} 
                  onClick={handleStimulate} 
                  disabled={!isConnected}
                  style={{ backgroundColor: isStimulating ? '#ff4d4d' : undefined }}
                >
                  {isStimulating ? 'Stop Stimulation' : 'Start Stimulation'}
                </button>
              </div>
              <div style={{ fontSize: '12px', color: '#666' }}>
                Command: E{electrode1}{electrode2}{electrode1}{electrode2}{electrode1}{electrode2}{electrode1}{electrode2}{String(amplitude).padStart(2, '0')}{isStimulating ? '1' : '0'}
              </div>
            </div>

            {/* Impedance Measurement Section */}
            <div style={{ marginTop: '16px', padding: '12px', border: '1px solid #ddd', borderRadius: '4px' }}>
              <h4 style={{ marginTop: 0 }}>Impedance Measurement</h4>
              <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button 
                  className={styles.button} 
                  onClick={handleInitializeImpedance} 
                  disabled={!isConnected}
                >
                  Initialize (9e)
                </button>
                <button 
                  className={styles.button} 
                  onClick={handleMeasureImpedance} 
                  disabled={!isConnected}
                >
                  Measure Impedance
                </button>
                <button 
                  className={styles.button} 
                  onClick={handleContinuousMeasurement} 
                  disabled={!isConnected || isContinuousMeasuring}
                  style={{ backgroundColor: isContinuousMeasuring ? '#999' : undefined }}
                >
                  {isContinuousMeasuring ? 'Measuring...' : 'Continuous Measurement'}
                </button>
                <button 
                  className={styles.button} 
                  onClick={clearImpedanceData} 
                  disabled={!isConnected || impedanceData.length === 0}
                >
                  Clear Data
                </button>
              </div>
              {lastResponse && (lastResponse.includes('G-ok') || lastResponse.includes('g')) && (
                <div style={{ fontSize: '12px', color: lastResponse.includes('ok') ? '#00b050' : '#666', marginBottom: '8px' }}>
                  Device: {lastResponse}
                </div>
              )}
              <div style={{ fontSize: '12px', color: '#666' }}>
                Electrodes 1-9 initialized. Impedance data: {impedanceData.length} measurement{impedanceData.length !== 1 ? 's' : ''}
              </div>
              {impedanceData.length > 0 && (
                <div style={{ marginTop: '8px', maxHeight: '100px', overflowY: 'auto', fontSize: '11px', backgroundColor: '#f5f5f5', padding: '4px', borderRadius: '2px' }}>
                  {impedanceData.map((item, idx) => (
                    <div key={idx} style={{ marginBottom: '2px' }}>
                      <span style={{ color: '#666', fontSize: '10px' }}>{item.timestamp}</span>
                      {' → '}
                      <span>{item.data}</span>
                    </div>
                  ))}
                </div>
              )}
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
              Save Sensor Recording
            </button>
            <div style={{ height: 8 }} />
            {/* Impedance save validation */}
            {impedanceSaveMissingReasons.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                {impedanceSaveMissingReasons.map((m, i) => (
                  <div key={i} className={styles.saveError}>{m}</div>
                ))}
              </div>
            )}
            <button
              className={styles.button}
              onClick={() => {
                handleSaveImpedance();
              }}
              disabled={
                !hasImpedanceData ||
                !patientName.trim() ||
                !sensorName.trim()
              }
            >
              Save Impedance Data
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
              {/* Sensor 1 (0-50) */}
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

              {/* Sensor 2 (0-50) */}
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





