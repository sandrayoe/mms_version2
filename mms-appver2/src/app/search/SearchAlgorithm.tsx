"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { useBluetooth } from "../BluetoothContext";
import styles from "./SearchAlgorithm.module.css";
import {
  calculateEffectiveness,
  createSearchTracker,
  updateElectrodeData,
  updateConfidenceMetrics,
  determinePotentiallyBestPairs,
  determineBestPair,
} from "./signalAnalysis";

type AlgorithmTab = "regular" | "superelectrode";

interface LogEntry {
  time: string;
  message: string;
}

interface SearchResult {
  electrode1: number | string;
  electrode2: number;
  amplitude: number;
  sensorAvg1: number;
  sensorAvg2: number;
  effectiveness: number;
  snr?: number;
  activationDetected?: boolean;
  response: string;
  timestamp: string;
}

/** Encode a byte value as 2-char uppercase hex ASCII (firmware GetPacketBinASCII). */
function getPacketBinASCII(value: number): string {
  return (value & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

const SearchAlgorithm: React.FC = () => {
  const {
    isConnected,
    connect,
    disconnect,
    sendCommand,
    lastResponse,
    stimulate,
    reconnectGATT,
    startIMU,
    stopIMU,
    clearIMU,
    imuData,
  } = useBluetooth();

  // Battery state
  const [showBatteryTooltip, setShowBatteryTooltip] = useState(false);
  const batteryPercentage = React.useMemo(() => {
    if (!lastResponse) return null;
    const match = lastResponse.match(/\d+/);
    if (match) {
      const Vbat = parseInt(match[0]);
      const minVoltage = 3400;
      const maxVoltage = 4200;
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
        setTimeout(() => setShowBatteryTooltip(false), 3000);
      } catch (err) {
        console.error('Failed to check battery:', err);
      }
    }
  };

  // Tab state
  const [activeTab, setActiveTab] = useState<AlgorithmTab>("regular");

  // Shared parameters
  const [minAmplitude, setMinAmplitude] = useState<string>("10");
  const [maxAmplitude, setMaxAmplitude] = useState<string>("15");
  const [delay, setDelay] = useState<string>("500");
  const [numElectrodes, setNumElectrodes] = useState<string>("9");

  // Superelectrode Phase 1 threshold (raw sensor effectiveness value)
  const [sensorThreshold, setSensorThreshold] = useState<string>("20");

  // Superelectrode phase tracking
  const [superPhase, setSuperPhase] = useState<1 | 2 | null>(null);
  const [foundAmplitude, setFoundAmplitude] = useState<number | null>(null);

  // Track live connection state inside async loops
  const isConnectedRef = useRef(isConnected);
  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  // Algorithm state
  const [isRunning, setIsRunning] = useState(false);
  const isRunningRef = useRef(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Currently stimulating electrode pair
  const [currentStimPair, setCurrentStimPair] = useState<{ e1: number; e2: number } | null>(null);
  const [currentAmplitude, setCurrentAmplitude] = useState<number | null>(null);
  const [electrodesTested, setElectrodesTested] = useState(0);
  const [totalCombinations, setTotalCombinations] = useState(0);

  // Best result from last completed search
  const [bestResult, setBestResult] = useState<SearchResult | null>(null);

  // Ref to always read fresh imuData inside async loops
  const imuDataRef = useRef(imuData);
  useEffect(() => {
    imuDataRef.current = imuData;
  }, [imuData]);

  // Ref to always read fresh lastResponse inside async loops
  const lastResponseRef = useRef(lastResponse);
  useEffect(() => {
    lastResponseRef.current = lastResponse;
  }, [lastResponse]);

  const addLog = useCallback((message: string) => {
    const now = new Date();
    const time = now.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0");
    setLog((prev) => [...prev, { time, message }]);
    setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  const addResult = useCallback((result: SearchResult) => {
    setResults((prev) => [...prev, result]);
  }, []);

  // Wait for a specific device response
  const waitForResponse = useCallback(
    (expected: string, timeoutMs = 5000) =>
      new Promise<string>((resolve, reject) => {
        const start = Date.now();
        let lastSeen = "";
        const check = () => {
          const cur = lastResponse;
          if (cur) lastSeen = cur;
          if (cur && cur.includes(expected)) return resolve(cur);
          if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for "${expected}" (last: "${lastSeen}")`));
          setTimeout(check, 150);
        };
        check();
      }),
    [lastResponse]
  );

  const delayMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Retry wrapper for BLE write operations that may fail with GATT errors.
   *  On first failure: reconnect GATT immediately, then retry.
   *  Retries up to `maxRetries` times. */
  const retryBLE = async <T,>(fn: () => Promise<T>, label: string, maxRetries = 3): Promise<T> => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const msg = err?.message || String(err);
        const isGATT = /gatt|network|write|characteristic/i.test(msg);
        if (attempt < maxRetries - 1 && isGATT) {
          console.warn(`BLE retry ${attempt + 1}/${maxRetries} for ${label}: ${msg}`);
          // Reconnect GATT immediately on any failure — the queue is likely saturated
          try {
            await reconnectGATT();
            await delayMs(400);
            clearIMU();
            await startIMU();
            await delayMs(200);
          } catch {
            // If reconnect fails, wait longer before next attempt
            await delayMs(1000);
          }
        } else {
          throw err;
        }
      }
    }
    throw new Error(`BLE ${label} failed after ${maxRetries} retries`);
  };

  /** Emergency stop: stop stimulation, stop sensors, then full firmware reset. */
  const emergencyStop = async () => {
    try {
      // stimulate() now sends raw binary — electrode 0,0 amp 0, go=false
      await stimulate(0, 0, 0, false);
    } catch {}
    try {
      // Stop sensors
      await sendCommand("B");
    } catch {}
    try {
      // Full firmware reset — stops everything on the device
      await sendCommand("N");
    } catch {}
    return true;
  };

  /** Abortable pause matching the reference pause-node behaviour.
   *  Checks isRunningRef every 100 ms and rejects early if the user stops. */
  const pauseNode = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout>;

      const checkAbort = setInterval(() => {
        if (!isRunningRef.current) {
          clearInterval(checkAbort);
          clearTimeout(timeoutId);
          reject(new Error("Flow aborted"));
        }
      }, 100);

      timeoutId = setTimeout(() => {
        clearInterval(checkAbort);
        if (!isRunningRef.current) {
          reject(new Error("Flow aborted"));
        } else {
          resolve();
        }
      }, ms);
    });

  // ─── Regular Search Algorithm ───
  // Based on the flow: loop through all electrode pair combinations at each amplitude,
  // start sensors → start stimulation → pause (collect data) → stop stimulation →
  // stop sensors → analyze sensor response → advance to next combination.
  const runRegularSearch = async () => {
    const minAmp = parseInt(minAmplitude);
    const maxAmp = parseInt(maxAmplitude);
    const delayS = parseFloat(delay);
    const totalElec = parseInt(numElectrodes);

    if ([minAmp, maxAmp, totalElec].some(isNaN) || isNaN(delayS)) {
      window.alert("Please fill in all parameters with valid numbers.");
      return;
    }
    if (minAmp < 0 || maxAmp > 120 || minAmp > maxAmp) {
      window.alert("Amplitude range invalid (0-120 mA, min <= max).");
      return;
    }
    if (totalElec < 2 || totalElec > 32) {
      window.alert("Total electrodes must be between 2 and 32.");
      return;
    }

    // Calculate total combinations: C(n,2) * amplitude range
    const pairsCount = (totalElec * (totalElec - 1)) / 2;
    const ampSteps = maxAmp - minAmp + 1;
    const total = pairsCount * ampSteps;
    setTotalCombinations(total);
    setElectrodesTested(0);

    setIsRunning(true);
    isRunningRef.current = true;
    setBestResult(null);
    setResults([]);
    const startTime = Date.now();
    addLog(`Regular Search started: ${totalElec} electrodes, amplitude ${minAmp}-${maxAmp} mA, delay ${delayS} ms`);
    addLog(`Total combinations to test: ${total} (${pairsCount} pairs × ${ampSteps} amplitudes)`);

    // Start sensors once for the entire search
    clearIMU();
    await startIMU();
    await delayMs(300); // initial warm-up

    // Track best pair across all tests
    type PairRecord = { anode: number; cathode: number; effectiveness: number; atAmplitude: number; avg1: number; avg2: number };
    const pairBestMap = new Map<string, PairRecord>();
    const tracker = createSearchTracker();
    const uniqueCombinations = pairsCount;
    let confidenceBestFound = false;
    let tested = 0;

    try {
      // Outer loop: amplitude (matches reference loop-node logic)
      for (let amp = minAmp; amp <= maxAmp; amp++) {
        if (!isRunningRef.current) { addLog("Search stopped by user."); break; }

        // Inner loops: all electrode pairs (anode < cathode)
        for (let anode = 1; anode <= totalElec - 1; anode++) {
          if (!isRunningRef.current) break;

          for (let cathode = anode + 1; cathode <= totalElec; cathode++) {
            if (!isRunningRef.current) break;

            // Abort cleanly if BLE disconnected mid-search
            if (!isConnectedRef.current) {
              addLog("⚠ BLE disconnected — stopping search.");
              isRunningRef.current = false;
              break;
            }

            tested++;
            setElectrodesTested(tested);

            setCurrentStimPair({ e1: anode, e2: cathode });
            setCurrentAmplitude(amp);
            addLog(`[${tested}/${total}] Pair ${anode}-${cathode} at ${amp} mA`);

            try {
              // 1. Clear previous sensor data before each pair.
              //    Clear both React state AND the ref, then wait for any
              //    in-flight BLE notifications to flush so we don't capture
              //    residual data from the previous stimulation.
              clearIMU();
              await delayMs(150);
              // Double-clear: discard anything that arrived during the settle window
              clearIMU();
              await delayMs(50);

              // 2. Start stimulation (electrodes are 1-based, matching firmware)
              await retryBLE(() => stimulate(anode, cathode, amp, true), `stim-on ${anode}-${cathode}`);

              // 3. Collect data during the configured delay (abortable pause-node)
              await pauseNode(delayS);

              // 4. Stop stimulation
              await retryBLE(() => stimulate(anode, cathode, amp, false), `stim-off ${anode}-${cathode}`);

              // 5. Flush sensor data from during stimulation (removes proximity artifacts)
              clearIMU();
              await delayMs(50);

              // 6. Post-stimulation listening: capture only genuine muscle response
              await delayMs(300);

              // 7. Analyze sensor data — only post-stim data (no stim artifacts)
              const s1 = imuDataRef.current.imu1_changes.map((s) => s.value);
              const s2 = imuDataRef.current.imu2_changes.map((s) => s.value);
              const avg1 = s1.length > 0 ? s1.reduce((a, b) => a + b, 0) / s1.length : 0;
              const avg2 = s2.length > 0 ? s2.reduce((a, b) => a + b, 0) / s2.length : 0;
              const { effectiveness: effValue, avgSnr, activationDetected } = calculateEffectiveness(s1, s2);

              addLog(`  → Eff: ${effValue.toFixed(2)}  SNR: ${avgSnr.toFixed(1)}dB  Active: ${activationDetected ? "YES" : "no"}  Avg: ${avg1.toFixed(1)}/${avg2.toFixed(1)}  (${s1.length}+${s2.length} samples)`);

              // 6. Update confidence tracker
              updateElectrodeData(tracker, effValue, avgSnr, activationDetected, anode, cathode);
              updateConfidenceMetrics(tracker, effValue, avgSnr, anode, cathode);

              // 7. Track best effectiveness for this pair
              const key = `${anode}-${cathode}`;
              const existing = pairBestMap.get(key);
              if (!existing || effValue > existing.effectiveness) {
                pairBestMap.set(key, { anode, cathode, effectiveness: effValue, atAmplitude: amp, avg1, avg2 });
              }

              // 8. Check for early termination via confidence
              const potentialBest = determinePotentiallyBestPairs(tracker);
              const earlyBest = determineBestPair(potentialBest, uniqueCombinations);
              if (earlyBest) {
                const bestKey = `${earlyBest.anode}-${earlyBest.cathode}`;
                const bestRecord = pairBestMap.get(bestKey);
                const elapsedMs = Date.now() - startTime;
                const mins = Math.floor(elapsedMs / 60000);
                const secs = Math.floor((elapsedMs % 60000) / 1000);
                const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                addLog(`✓ Early stop — confident best pair: ${earlyBest.anode}-${earlyBest.cathode} (confidence: ${earlyBest.confidenceMetric.toFixed(3)}, activations: ${earlyBest.activations}/${earlyBest.counts})`);
                setBestResult({
                  electrode1: earlyBest.anode,
                  electrode2: earlyBest.cathode,
                  amplitude: bestRecord?.atAmplitude ?? amp,
                  sensorAvg1: parseFloat((bestRecord?.avg1 ?? avg1).toFixed(2)),
                  sensorAvg2: parseFloat((bestRecord?.avg2 ?? avg2).toFixed(2)),
                  effectiveness: parseFloat((bestRecord?.effectiveness ?? effValue).toFixed(2)),
                  snr: parseFloat(avgSnr.toFixed(2)),
                  activationDetected,
                  response: `Confidence: ${earlyBest.confidenceMetric.toFixed(3)}`,
                  timestamp: duration,
                });
                confidenceBestFound = true;
                isRunningRef.current = false;
              }

              // 9. Record result
              const result: SearchResult = {
                electrode1: anode,
                electrode2: cathode,
                amplitude: amp,
                sensorAvg1: parseFloat(avg1.toFixed(2)),
                sensorAvg2: parseFloat(avg2.toFixed(2)),
                effectiveness: parseFloat(effValue.toFixed(2)),
                snr: parseFloat(avgSnr.toFixed(2)),
                activationDetected,
                response: `Eff: ${effValue.toFixed(2)}  SNR: ${avgSnr.toFixed(1)}dB  ${activationDetected ? "✓" : "–"}`,
                timestamp: new Date().toLocaleTimeString("en-GB", { hour12: false }),
              };
              addResult(result);
            } catch (pairErr: any) {
              if (pairErr.message === "Flow aborted") throw pairErr; // re-throw user stop
              addLog(`  ⚠ Skipped pair ${anode}-${cathode} @ ${amp} mA — ${pairErr.message || pairErr}`);
              // Try to stop stimulation anyway before continuing
              try { await stimulate(anode, cathode, amp, false); } catch {}
            }

            setCurrentStimPair(null);
            setCurrentAmplitude(null);
          }
        }
      }

      // Log confidence summary
      if (tracker.pairData.length > 0) {
        const sorted = [...tracker.pairData].sort((a, b) => b.confidenceMetric - a.confidenceMetric);
        addLog(`── Confidence Summary (top ${Math.min(3, sorted.length)} pairs) ──`);
        for (const p of sorted.slice(0, 3)) {
          addLog(`  ${p.anode}-${p.cathode}: conf=${p.confidenceMetric.toFixed(3)}, act=${p.activations}/${p.counts}, eff=${(p.counts > 0 ? p.totalEffectiveness / p.counts : 0).toFixed(2)}`);
        }
      }

      // Determine overall best pair (skip if confidence-based early stop already found one)
      if (pairBestMap.size > 0 && !confidenceBestFound) {
        // Try confidence-based determination first
        const potentialBest = determinePotentiallyBestPairs(tracker);
        const confBest = determineBestPair(potentialBest, uniqueCombinations);

        let bestAnode: number, bestCathode: number, bestAmp: number, bestAvg1: number, bestAvg2: number, bestEff: number;

        if (confBest) {
          const record = pairBestMap.get(`${confBest.anode}-${confBest.cathode}`);
          bestAnode = confBest.anode;
          bestCathode = confBest.cathode;
          bestAmp = record?.atAmplitude ?? 0;
          bestAvg1 = record?.avg1 ?? 0;
          bestAvg2 = record?.avg2 ?? 0;
          bestEff = record?.effectiveness ?? 0;
          addLog(`Best pair determined by confidence metric (${confBest.confidenceMetric.toFixed(3)})`);
        } else {
          // Fallback: highest raw effectiveness
          const best = Array.from(pairBestMap.values()).reduce((a, b) =>
            a.effectiveness > b.effectiveness ? a : b
          );
          bestAnode = best.anode;
          bestCathode = best.cathode;
          bestAmp = best.atAmplitude;
          bestAvg1 = best.avg1;
          bestAvg2 = best.avg2;
          bestEff = best.effectiveness;
        }

        const elapsedMs = Date.now() - startTime;
        const mins = Math.floor(elapsedMs / 60000);
        const secs = Math.floor((elapsedMs % 60000) / 1000);
        const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        setBestResult({
          electrode1: bestAnode,
          electrode2: bestCathode,
          amplitude: bestAmp,
          sensorAvg1: parseFloat(bestAvg1.toFixed(2)),
          sensorAvg2: parseFloat(bestAvg2.toFixed(2)),
          effectiveness: parseFloat(bestEff.toFixed(2)),
          response: `Effectiveness: ${bestEff.toFixed(2)}`,
          timestamp: duration,
        });
        addLog(`✓ Best pair: ${bestAnode}-${bestCathode} at ${bestAmp} mA (effectiveness: ${bestEff.toFixed(2)}) — completed in ${duration}`);
      }

      addLog("Regular Search completed.");
      await stopIMU();
    } catch (err: any) {
      addLog(`Error: ${err.message || err}`);
      // Emergency stop: send 'e' with all zeros to stop stimulation
      try {
        await emergencyStop();
        addLog("Emergency stop sent.");
      } catch {}
    } finally {
      setIsRunning(false);
      isRunningRef.current = false;
      setCurrentStimPair(null);
      setCurrentAmplitude(null);
    }
  };

  // ─── Superelectrode Search Algorithm ───
  // Uses 'F' command: electrodes 1-3 are grouped as one big positive pole,
  // a single electrode from 4–9 is the ground pole.
  // Protocol: F + XX (2-digit ASCII electrode) + amplitude (2-byte hex-ASCII) + go/stop ('0'/'1')

  /** Send the 'F' superelectrode command over UART. */
  const sendSuperelectrodeCommand = async (electrode: number, amplitude: number, go: boolean) => {
    const elStr = electrode.toString().padStart(2, '0');  // e.g. '04'
    const ampStr = getPacketBinASCII(amplitude);           // e.g. '0A'
    const goStr = go ? '1' : '0';
    const packet = 'F' + elStr + ampStr + goStr;
    await sendCommand(packet);
    console.log(`Superelectrode F command: ${packet} | Electrode=${electrode} Amp=${amplitude} Go=${go}`);
  };

  const runSuperelectrodeSearch = async () => {
    const minAmp = parseInt(minAmplitude);
    const maxAmp = parseInt(maxAmplitude);
    const delayS = parseFloat(delay);
    const totalElec = parseInt(numElectrodes);
    const threshold = parseFloat(sensorThreshold);

    if ([minAmp, maxAmp, totalElec].some(isNaN) || isNaN(delayS) || isNaN(threshold)) {
      window.alert("Please fill in all parameters with valid numbers.");
      return;
    }
    if (minAmp < 0 || maxAmp > 120 || minAmp > maxAmp) {
      window.alert("Amplitude range invalid (0-120 mA, min <= max).");
      return;
    }
    if (threshold <= 0) {
      window.alert("Sensor threshold must be a positive number.");
      return;
    }

    // Second electrode loops from 4 to totalElec (e.g. 9 electrodes → 4-9, 16 → 4-16)
    const startElectrode = 4;
    const endElectrode = totalElec;
    const ampSteps = maxAmp - minAmp + 1;
    const electrodeSteps = endElectrode - startElectrode + 1;

    // Phase 1 total = ampSteps * electrodeSteps (worst case, all amplitudes)
    // Phase 2 total = electrodeSteps (single amplitude sweep)
    const phase1Max = ampSteps * electrodeSteps;
    const phase2Total = electrodeSteps;
    setTotalCombinations(phase1Max); // start with phase 1 estimate
    setElectrodesTested(0);

    setIsRunning(true);
    isRunningRef.current = true;
    setBestResult(null);
    setResults([]);
    setSuperPhase(1);
    setFoundAmplitude(null);
    const startTime = Date.now();
    addLog(`═══ Superelectrode Search (2-Phase) ═══`);
    addLog(`Grouped anode (1-3), cathode ${startElectrode}-${endElectrode}, amplitude ${minAmp}-${maxAmp} mA, delay ${delayS} ms`);
    addLog(`Sensor threshold: ${threshold}`);

    // Start sensors once for the entire search
    clearIMU();
    await startIMU();
    await delayMs(300); // initial warm-up

    let tested = 0;
    let optimalAmplitude: number | null = null;

    try {
      // ═══════════════════════════════════════════════
      // PHASE 1: Amplitude Search
      // Sweep amplitudes from min→max. At each amplitude, stimulate ALL
      // electrodes 4→X in sequence and collect combined sensor data.
      // Stop as soon as effectiveness meets the threshold.
      // ═══════════════════════════════════════════════
      addLog(`── Phase 1: Searching for optimal amplitude (threshold: ${threshold}) ──`);

      for (let amp = minAmp; amp <= maxAmp; amp++) {
        if (!isRunningRef.current) { addLog("Search stopped by user."); break; }
        if (!isConnectedRef.current) {
          addLog("⚠ BLE disconnected — stopping search.");
          isRunningRef.current = false;
          break;
        }

        addLog(`Phase 1: Testing amplitude ${amp} mA across all electrodes ${startElectrode}-${endElectrode}`);

        // Clear sensor data once for the whole amplitude level
        clearIMU();
        await delayMs(50);

        // Stimulate each electrode 4→X at this amplitude
        for (let elec = startElectrode; elec <= endElectrode; elec++) {
          if (!isRunningRef.current) break;
          if (!isConnectedRef.current) {
            addLog("⚠ BLE disconnected — stopping search.");
            isRunningRef.current = false;
            break;
          }

          tested++;
          setElectrodesTested(tested);
          setCurrentStimPair({ e1: 0, e2: elec });
          setCurrentAmplitude(amp);

          try {
            // Stimulate this electrode (Phase 1 uses half the configured delay)
            await retryBLE(() => sendSuperelectrodeCommand(elec, amp, true), `super-on ${elec}`);
            await pauseNode(delayS / 2);
            await retryBLE(() => sendSuperelectrodeCommand(elec, amp, false), `super-off ${elec}`);
            await delayMs(200);
          } catch (pairErr: any) {
            if (pairErr.message === "Flow aborted") throw pairErr;
            addLog(`  ⚠ Skipped electrode ${elec} @ ${amp} mA — ${pairErr.message || pairErr}`);
            try { await sendSuperelectrodeCommand(elec, amp, false); } catch {}
          }

          setCurrentStimPair(null);
          setCurrentAmplitude(null);
        }

        if (!isRunningRef.current) break;

        // Post-stimulation listening period: collect sensor data after all electrodes have been stimulated
        addLog(`  Listening for 300 ms after stimulation at ${amp} mA…`);
        await delayMs(300);

        // After stimulating all electrodes at this amplitude, analyze combined sensor data
        const s1 = imuDataRef.current.imu1_changes.map((s) => s.value);
        const s2 = imuDataRef.current.imu2_changes.map((s) => s.value);
        const avg1 = s1.length > 0 ? s1.reduce((a, b) => a + b, 0) / s1.length : 0;
        const avg2 = s2.length > 0 ? s2.reduce((a, b) => a + b, 0) / s2.length : 0;
        const { effectiveness: combinedEff } = calculateEffectiveness(s1, s2);

        // Also check raw max values
        const maxRaw1 = s1.length > 0 ? Math.max(...s1.map(Math.abs)) : 0;
        const maxRaw2 = s2.length > 0 ? Math.max(...s2.map(Math.abs)) : 0;
        const maxRaw = Math.max(maxRaw1, maxRaw2);

        addLog(`  Phase 1 @ ${amp} mA → Effectiveness: ${combinedEff.toFixed(2)}  |  Max raw: ${maxRaw.toFixed(1)}  |  Avg: ${avg1.toFixed(1)} / ${avg2.toFixed(1)}  (${s1.length}+${s2.length} samples)`);

        // Record Phase 1 result
        const p1Result: SearchResult = {
          electrode1: "A",
          electrode2: 0,
          amplitude: amp,
          sensorAvg1: parseFloat(avg1.toFixed(2)),
          sensorAvg2: parseFloat(avg2.toFixed(2)),
          effectiveness: parseFloat(combinedEff.toFixed(2)),
          response: `P1 @ ${amp}mA | Eff: ${combinedEff.toFixed(2)} | MaxRaw: ${maxRaw.toFixed(1)}`,
          timestamp: new Date().toLocaleTimeString("en-GB", { hour12: false }),
        };
        addResult(p1Result);

        // Check if max raw sensor value exceeds threshold
        if (maxRaw >= threshold) {
          optimalAmplitude = amp;
          setFoundAmplitude(amp);
          addLog(`✓ Phase 1 complete: Threshold ${threshold} reached at ${amp} mA (max raw: ${maxRaw.toFixed(1)})`);
          break;
        }
      }

      // If no amplitude met threshold, use the max amplitude with a warning
      if (optimalAmplitude === null && isRunningRef.current) {
        optimalAmplitude = maxAmp;
        setFoundAmplitude(maxAmp);
        addLog(`⚠ Phase 1: Threshold ${threshold} not reached. Using max amplitude ${maxAmp} mA for Phase 2.`);
      }

      if (!isRunningRef.current || optimalAmplitude === null) {
        addLog("Search stopped before Phase 2.");
        await stopIMU();
        return;
      }

      // ═══════════════════════════════════════════════
      // PHASE 2: Pair Selection (2 rounds, averaged)
      // At the found amplitude, stimulate each electrode 4→X twice,
      // average the effectiveness, and determine the best one.
      // ═══════════════════════════════════════════════
      setSuperPhase(2);
      const phase2Rounds = 2;
      setTotalCombinations(phase2Total * phase2Rounds);
      setElectrodesTested(0);
      tested = 0;

      addLog(`── Phase 2: Finding best electrode pair at ${optimalAmplitude} mA (${phase2Rounds} rounds each) ──`);

      type PairRecord = { electrode: number; effectiveness: number; atAmplitude: number; avg1: number; avg2: number };
      // Accumulate per-electrode results across rounds
      const elecResults = new Map<number, { effSum: number; snrSum: number; avg1Sum: number; avg2Sum: number; activations: number; rounds: number }>();
      const bestMap = new Map<number, PairRecord>();

      for (let round = 1; round <= phase2Rounds; round++) {
        if (!isRunningRef.current) break;
        addLog(`── Phase 2 — Round ${round}/${phase2Rounds} ──`);

        for (let elec = startElectrode; elec <= endElectrode; elec++) {
          if (!isRunningRef.current) { addLog("Search stopped by user."); break; }
          if (!isConnectedRef.current) {
            addLog("⚠ BLE disconnected — stopping search.");
            isRunningRef.current = false;
            break;
          }

          tested++;
          setElectrodesTested(tested);
          setCurrentStimPair({ e1: 0, e2: elec });
          setCurrentAmplitude(optimalAmplitude);
          addLog(`[${tested}/${phase2Total * phase2Rounds}] Phase 2 R${round}: (A) → ${elec} at ${optimalAmplitude} mA`);

          try {
            // 1. Clear previous sensor data and flush in-flight BLE notifications
            clearIMU();
            await delayMs(150);
            clearIMU();
            await delayMs(50);

            // 2. Start stimulation via 'F' command
            await retryBLE(() => sendSuperelectrodeCommand(elec, optimalAmplitude!, true), `P2-on ${elec}`);

            // 3. Collect data during configured delay (abortable)
            await pauseNode(delayS);

            // 4. Stop stimulation
            await retryBLE(() => sendSuperelectrodeCommand(elec, optimalAmplitude!, false), `P2-off ${elec}`);

            // 5. Flush sensor data from during stimulation (removes proximity artifacts)
            clearIMU();
            await delayMs(50);

            // 6. Post-stimulation listening: capture only genuine muscle response
            await delayMs(400);

            // 7. Analyze sensor data — only post-stim data (no stim artifacts)
            const s1 = imuDataRef.current.imu1_changes.map((s) => s.value);
            const s2 = imuDataRef.current.imu2_changes.map((s) => s.value);
            const avg1 = s1.length > 0 ? s1.reduce((a, b) => a + b, 0) / s1.length : 0;
            const avg2 = s2.length > 0 ? s2.reduce((a, b) => a + b, 0) / s2.length : 0;
            const { effectiveness: effValue, avgSnr, activationDetected } = calculateEffectiveness(s1, s2);

            addLog(`  → Eff: ${effValue.toFixed(2)}  SNR: ${avgSnr.toFixed(1)}dB  Active: ${activationDetected ? "YES" : "no"}  Avg: ${avg1.toFixed(1)}/${avg2.toFixed(1)}  (${s1.length}+${s2.length} samples)`);

            // 7. Accumulate results for averaging
            const prev = elecResults.get(elec) || { effSum: 0, snrSum: 0, avg1Sum: 0, avg2Sum: 0, activations: 0, rounds: 0 };
            prev.effSum += effValue;
            prev.snrSum += avgSnr;
            prev.avg1Sum += avg1;
            prev.avg2Sum += avg2;
            prev.activations += activationDetected ? 1 : 0;
            prev.rounds += 1;
            elecResults.set(elec, prev);

            // 8. Record individual round result
            const result: SearchResult = {
              electrode1: "A",
              electrode2: elec,
              amplitude: optimalAmplitude,
              sensorAvg1: parseFloat(avg1.toFixed(2)),
              sensorAvg2: parseFloat(avg2.toFixed(2)),
              effectiveness: parseFloat(effValue.toFixed(2)),
              snr: parseFloat(avgSnr.toFixed(2)),
              activationDetected,
              response: `P2 R${round} | Eff: ${effValue.toFixed(2)}  SNR: ${avgSnr.toFixed(1)}dB  ${activationDetected ? "✓" : "–"}`,
              timestamp: new Date().toLocaleTimeString("en-GB", { hour12: false }),
            };
            addResult(result);
          } catch (pairErr: any) {
            if (pairErr.message === "Flow aborted") throw pairErr;
            addLog(`  ⚠ Skipped electrode ${elec} R${round} @ ${optimalAmplitude} mA — ${pairErr.message || pairErr}`);
            try { await sendSuperelectrodeCommand(elec, optimalAmplitude, false); } catch {}
          }

          setCurrentStimPair(null);
          setCurrentAmplitude(null);
        }
      }

      // Compute averaged effectiveness per electrode and pick the best
      for (const [elec, acc] of elecResults.entries()) {
        if (acc.rounds === 0) continue;
        const avgEff = acc.effSum / acc.rounds;
        const avgA1 = acc.avg1Sum / acc.rounds;
        const avgA2 = acc.avg2Sum / acc.rounds;
        addLog(`  Electrode ${elec}: avg eff=${avgEff.toFixed(2)} over ${acc.rounds} rounds (activations: ${acc.activations}/${acc.rounds})`);
        bestMap.set(elec, { electrode: elec, effectiveness: avgEff, atAmplitude: optimalAmplitude, avg1: avgA1, avg2: avgA2 });
      }

      // Determine overall best electrode from Phase 2
      if (bestMap.size > 0) {
        const best = Array.from(bestMap.values()).reduce((a, b) =>
          a.effectiveness > b.effectiveness ? a : b
        );
        const elapsedMs = Date.now() - startTime;
        const mins = Math.floor(elapsedMs / 60000);
        const secs = Math.floor((elapsedMs % 60000) / 1000);
        const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        const bestResult: SearchResult = {
          electrode1: "A",
          electrode2: best.electrode,
          amplitude: best.atAmplitude,
          sensorAvg1: parseFloat(best.avg1.toFixed(2)),
          sensorAvg2: parseFloat(best.avg2.toFixed(2)),
          effectiveness: parseFloat(best.effectiveness.toFixed(2)),
          response: `Effectiveness: ${best.effectiveness.toFixed(2)}`,
          timestamp: duration,
        };
        setBestResult(bestResult);
        addLog(`✓ Best electrode: (A) → ${best.electrode} at ${best.atAmplitude} mA (effectiveness: ${best.effectiveness.toFixed(2)}) — completed in ${duration}`);
      }

      addLog("Superelectrode Search completed.");
      await stopIMU();
    } catch (err: any) {
      addLog(`Error: ${err.message || err}`);
      try {
        await emergencyStop();
        addLog("Emergency stop sent.");
      } catch {}
    } finally {
      setIsRunning(false);
      isRunningRef.current = false;
      setCurrentStimPair(null);
      setCurrentAmplitude(null);
      setSuperPhase(null);
    }
  };

  const handleStart = () => {
    if (activeTab === "regular") {
      runRegularSearch();
    } else {
      runSuperelectrodeSearch();
    }
  };

  const handleStop = async () => {
    isRunningRef.current = false;
    setIsRunning(false);
    addLog("Stop requested — stopping stimulation and sensors...");
    try {
      await emergencyStop();
      addLog("Stimulation and sensors stopped.");
    } catch (err) {
      addLog("Warning: failed to send stop commands to device.");
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <img className={styles.logo} src="/mms_logo_2.png" alt="MMS Logo" />
        <h1 className={styles.heading}>Search Algorithm</h1>
        <p className={styles.subHeading}>Electrode pair (motor points) search</p>
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

      {!isConnected && (
        <div className={styles.notConnectedCard}>
          <strong>Not Connected</strong> — Connect to the MMS device to begin searching.
          <button
            className={styles.button}
            onClick={connect}
            style={{ marginLeft: 16, padding: "6px 20px", fontSize: 14 }}
          >
            Connect
          </button>
        </div>
      )}

      {/* Tab Navigation */}
      <div className={styles.tabContainer}>
        <button
          className={`${styles.tab} ${activeTab === "regular" ? styles.tabActive : ""}`}
          onClick={() => !isRunning && setActiveTab("regular")}
          disabled={isRunning}
        >
          Regular Search
        </button>
        <button
          className={`${styles.tab} ${activeTab === "superelectrode" ? styles.tabActive : ""}`}
          onClick={() => !isRunning && setActiveTab("superelectrode")}
          disabled={isRunning}
        >
          Superelectrode Algorithm
        </button>
      </div>

      {/* Shared Parameters */}
      <div className={styles.parametersCard}>
        <h3>Parameters</h3>
        <div className={styles.parameterGrid}>
          <label className={styles.inputLabel}>
            <span className={styles.labelRow}>Min Amplitude (mA):</span>
            <input
              className={`${styles.textInput} ${styles.smallInput}`}
              type="number"
              min="0"
              max="120"
              value={minAmplitude}
              onChange={(e) => setMinAmplitude(e.target.value)}
              disabled={isRunning}
            />
          </label>
          <label className={styles.inputLabel}>
            <span className={styles.labelRow}>Max Amplitude (mA):</span>
            <input
              className={`${styles.textInput} ${styles.smallInput}`}
              type="number"
              min="0"
              max="120"
              value={maxAmplitude}
              onChange={(e) => setMaxAmplitude(e.target.value)}
              disabled={isRunning}
            />
          </label>
          <label className={styles.inputLabel}>
            <span className={styles.labelRow}>Delay (ms):</span>
            <input
              className={`${styles.textInput} ${styles.smallInput}`}
              type="number"
              min="100"
              step="100"
              value={delay}
              onChange={(e) => setDelay(e.target.value)}
              disabled={isRunning}
            />
          </label>
          <label className={styles.inputLabel}>
            <span className={styles.labelRow}>Total Electrodes:</span>
            <input
              className={`${styles.textInput} ${styles.smallInput}`}
              type="number"
              min="2"
              max="32"
              value={numElectrodes}
              onChange={(e) => setNumElectrodes(e.target.value)}
              disabled={isRunning}
            />
          </label>
          {activeTab === "superelectrode" && (
            <label className={styles.inputLabel}>
              <span className={styles.labelRow}>Sensor Threshold:</span>
              <input
                className={`${styles.textInput} ${styles.smallInput}`}
                type="number"
                min="1"
                step="5"
                value={sensorThreshold}
                onChange={(e) => setSensorThreshold(e.target.value)}
                disabled={isRunning}
              />
            </label>
          )}
        </div>
      </div>

      {/* Algorithm Description & Controls */}
      <div className={styles.algorithmSection}>
        <h3>{activeTab === "regular" ? "Regular Search" : "Superelectrode Algorithm"}</h3>
        <p className={styles.algorithmDescription}>
          {activeTab === "regular"
            ? "Loops through every electrode pair combination at each amplitude. For each test: starts sensors → stimulates → collects data → stops → analyses sensor response. Finds the best pair with the highest sensor response."
            : "Two-phase search: Phase 1 sweeps amplitudes from min→max, stimulating all electrodes 4→X at each level and checking if the combined sensor response meets the threshold. Phase 2 uses the found amplitude to test each electrode individually and determine the best pair."}
        </p>

        <div className={styles.statusBar}>
          <span className={`${styles.statusDot} ${isRunning ? styles.statusRunning : styles.statusIdle}`} />
          <span>{isRunning ? "Running..." : "Idle"}</span>
          {currentStimPair && (
            <span style={{ marginLeft: 16, fontWeight: 600 }}>
              Stimulating: Electrode {currentStimPair.e1 === 0 ? "A" : currentStimPair.e1} – {currentStimPair.e2}
              {currentAmplitude !== null && ` at ${currentAmplitude} mA`}
            </span>
          )}
          {isRunning && totalCombinations > 0 && (
            <span style={{ marginLeft: 16, color: "#999" }}>
              {activeTab === "superelectrode" && superPhase ? `Phase ${superPhase} — ` : ""}
              Progress: {electrodesTested}/{totalCombinations} ({Math.round((electrodesTested / totalCombinations) * 100)}%)
              {foundAmplitude !== null && ` | Found amp: ${foundAmplitude} mA`}
            </span>
          )}
        </div>
        {isRunning && totalCombinations > 0 && (
          <div style={{ width: "100%", background: "#333", borderRadius: 4, height: 6, marginTop: 8 }}>
            <div
              style={{
                width: `${(electrodesTested / totalCombinations) * 100}%`,
                background: "#4fc3f7",
                height: "100%",
                borderRadius: 4,
                transition: "width 0.3s",
              }}
            />
          </div>
        )}

        <div className={styles.buttonContainer}>
          <button className={styles.button} onClick={handleStart} disabled={!isConnected || isRunning}>
            {activeTab === "regular" ? "Run Regular Search" : "Run Superelectrode Search"}
          </button>
          <button
            className={`${styles.button} ${isRunning ? styles.runningButton : ""}`}
            onClick={handleStop}
            disabled={!isRunning}
          >
            Stop
          </button>
        </div>

        {lastResponse && (
          <div className={`${styles.deviceResponse} ${lastResponse.includes("ok") ? styles.deviceResponseOk : styles.deviceResponseInfo}`}>
            Device: {lastResponse}
          </div>
        )}
      </div>

      {/* Log */}
      {log.length > 0 && (
        <div className={styles.resultsCard}>
          <h3>Log</h3>
          <div className={styles.logArea}>
            {log.map((entry, i) => (
              <div key={i} className={styles.logEntry}>
                <span className={styles.logTimestamp}>[{entry.time}]</span>
                {entry.message}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {/* Best Result */}
      <div className={styles.resultsCard}>
        <h3>Best Electrode Pair</h3>
        {!bestResult && !isRunning && results.length === 0 && (
          <div className={styles.emptyResults}>No results yet. Run a search algorithm to find the best electrode pair.</div>
        )}
        {!bestResult && isRunning && (
          <div className={styles.emptyResults}>Search in progress…</div>
        )}
        {!bestResult && !isRunning && results.length > 0 && (
          <div className={styles.emptyResults}>Search stopped before completion. No best pair determined.</div>
        )}
        {bestResult && (
          <div className={styles.bestResultCard}>
            <div className={styles.bestResultPair}>
              <span className={styles.bestResultLabel}>Electrode Pair</span>
              <span className={styles.bestResultValue}>{bestResult.electrode1} – {bestResult.electrode2}</span>
            </div>
            <div className={styles.bestResultDetails}>
              <div>
                <span className={styles.bestResultLabel}>Amplitude</span>
                <span className={styles.bestResultValue}>{bestResult.amplitude} mA</span>
              </div>
              <div>
                <span className={styles.bestResultLabel}>Effectiveness</span>
                <span className={styles.bestResultValue}>{bestResult.effectiveness}</span>
              </div>
              <div>
                <span className={styles.bestResultLabel}>Duration</span>
                <span className={styles.bestResultValue}>{bestResult.timestamp}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchAlgorithm;
