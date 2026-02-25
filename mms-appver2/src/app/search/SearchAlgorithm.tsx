"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { useBluetooth } from "../BluetoothContext";
import styles from "./SearchAlgorithm.module.css";

type AlgorithmTab = "regular" | "superelectrode";

interface LogEntry {
  time: string;
  message: string;
}

interface SearchResult {
  electrode1: number;
  electrode2: number;
  amplitude: number;
  sensorAvg1: number;
  sensorAvg2: number;
  effectiveness: number;
  response: string;
  timestamp: string;
}

// Idle sensor value — sensor reading at rest (no stimulation)
const IDLE_VALUE = 0;

/** Calculate effectiveness based on squared deviation from idle. */
function calculateEffectiveness(
  sensor1Data: number[],
  sensor2Data: number[]
): { squaredDiff: number; maxDeviation: number } {
  const s1Sq =
    sensor1Data.length > 0
      ? sensor1Data.map((v) => Math.pow(v - IDLE_VALUE, 2)).reduce((a, b) => a + b, 0) / sensor1Data.length
      : 0;
  const s2Sq =
    sensor2Data.length > 0
      ? sensor2Data.map((v) => Math.pow(v - IDLE_VALUE, 2)).reduce((a, b) => a + b, 0) / sensor2Data.length
      : 0;

  const s1MaxDev =
    sensor1Data.length > 0 ? Math.max(...sensor1Data.map((v) => Math.abs(v - IDLE_VALUE))) : 0;
  const s2MaxDev =
    sensor2Data.length > 0 ? Math.max(...sensor2Data.map((v) => Math.abs(v - IDLE_VALUE))) : 0;

  return {
    squaredDiff: (s1Sq + s2Sq) / 2,
    maxDeviation: (s1MaxDev + s2MaxDev) / 2,
  };
}

const SearchAlgorithm: React.FC = () => {
  const {
    isConnected,
    connect,
    disconnect,
    sendCommand,
    lastResponse,
    stimulate,
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

  /** Emergency stop: stop stimulation via raw binary 'e' packet, then stop sensors. */
  const emergencyStop = async () => {
    try {
      // stimulate() now sends raw binary — electrode 0,0 amp 0, go=false
      await stimulate(0, 0, 0, false);
    } catch {}
    try {
      // Stop sensors
      await sendCommand("B");
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
              // 1. Clear previous sensor data before each pair
              clearIMU();
              await delayMs(50);

              // 2. Start stimulation (electrodes are 1-based, matching firmware)
              await stimulate(anode, cathode, amp, true);

              // 3. Collect data during the configured delay (abortable pause-node)
              await pauseNode(delayS);

              // 4. Stop stimulation (set amplitude to 0 and runStop to 0, matching reference)
              await stimulate(anode, cathode, amp, false);
              await delayMs(200); // let trailing data arrive

              // 5. Analyze sensor data — effectiveness = mean squared deviation from idle
              const s1 = imuDataRef.current.imu1_changes.map((s) => s.value);
              const s2 = imuDataRef.current.imu2_changes.map((s) => s.value);
              const avg1 = s1.length > 0 ? s1.reduce((a, b) => a + b, 0) / s1.length : 0;
              const avg2 = s2.length > 0 ? s2.reduce((a, b) => a + b, 0) / s2.length : 0;
              const { squaredDiff: effValue } = calculateEffectiveness(s1, s2);

              addLog(`  → Effectiveness: ${effValue.toFixed(2)}  |  Avg: ${avg1.toFixed(1)} / ${avg2.toFixed(1)}  (${s1.length}+${s2.length} samples)`);

              // 6. Track best effectiveness for this pair
              const key = `${anode}-${cathode}`;
              const existing = pairBestMap.get(key);
              if (!existing || effValue > existing.effectiveness) {
                pairBestMap.set(key, { anode, cathode, effectiveness: effValue, atAmplitude: amp, avg1, avg2 });
              }

              // 7. Record result
              const result: SearchResult = {
                electrode1: anode,
                electrode2: cathode,
                amplitude: amp,
                sensorAvg1: parseFloat(avg1.toFixed(2)),
                sensorAvg2: parseFloat(avg2.toFixed(2)),
                effectiveness: parseFloat(effValue.toFixed(2)),
                response: `Eff: ${effValue.toFixed(2)}  |  S1: ${avg1.toFixed(1)}  S2: ${avg2.toFixed(1)}`,
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

            // Every 25 pairs, stop stimulation + send 'N' + cycle IMU to reset
            // the firmware's internal state (it stops responding after ~36 pairs).
            if (tested > 0 && tested % 25 === 0 && isRunningRef.current) {
              addLog(`⟳ Firmware reset after ${tested} pairs…`);
              try {
                // Explicit stop stimulation first
                await stimulate(0, 0, 0, false);
                await delayMs(100);
                await stopIMU();
                await delayMs(200);
                await sendCommand("N");
                await delayMs(500);
                clearIMU();
                await startIMU();
                await delayMs(300);
                addLog(`⟳ Reset complete — continuing search.`);
              } catch (resetErr: any) {
                addLog(`⚠ Reset failed: ${resetErr.message || resetErr} — continuing anyway.`);
                try { clearIMU(); await startIMU(); await delayMs(300); } catch {}
              }
            }

            await delayMs(300); // gap between tests
          }
        }
      }

      // Determine overall best pair: highest effectiveness (squaredDiff)
      if (pairBestMap.size > 0) {
        const best = Array.from(pairBestMap.values()).reduce((a, b) =>
          a.effectiveness > b.effectiveness ? a : b
        );
        const elapsedMs = Date.now() - startTime;
        const mins = Math.floor(elapsedMs / 60000);
        const secs = Math.floor((elapsedMs % 60000) / 1000);
        const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        const bestResult: SearchResult = {
          electrode1: best.anode,
          electrode2: best.cathode,
          amplitude: best.atAmplitude,
          sensorAvg1: parseFloat(best.avg1.toFixed(2)),
          sensorAvg2: parseFloat(best.avg2.toFixed(2)),
          effectiveness: parseFloat(best.effectiveness.toFixed(2)),
          response: `Effectiveness: ${best.effectiveness.toFixed(2)}`,
          timestamp: duration,
        };
        setBestResult(bestResult);
        addLog(`✓ Best pair: ${best.anode}-${best.cathode} at ${best.atAmplitude} mA (effectiveness: ${best.effectiveness.toFixed(2)}) — completed in ${duration}`);
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
  const runSuperelectrodeSearch = async () => {
    const minAmp = parseInt(minAmplitude);
    const maxAmp = parseInt(maxAmplitude);
    const delayS = parseFloat(delay);

    if ([minAmp, maxAmp].some(isNaN) || isNaN(delayS)) {
      window.alert("Please fill in all parameters with valid numbers.");
      return;
    }
    if (minAmp < 0 || maxAmp > 120 || minAmp > maxAmp) {
      window.alert("Amplitude range invalid (0-120 mA, min <= max).");
      return;
    }

    setIsRunning(true);
    isRunningRef.current = true;
    setBestResult(null);
    setResults([]);
    addLog(`Superelectrode Search started: amplitude ${minAmp}-${maxAmp} mA, delay ${delayS} ms`);

    try {
      for (let amp = minAmp; amp <= maxAmp; amp += 1) {
        if (!isRunningRef.current) {
          addLog("Search stopped by user.");
          break;
        }

        addLog(`Testing superelectrode at amplitude ${amp} mA...`);
        setCurrentStimPair({ e1: 0, e2: 0 }); // TODO: set actual electrode pair

        // TODO: implement superelectrode device command for this amplitude step
        // await sendCommand(...);

        // Wait for the configured delay
        await delayMs(delayS);

        // Record result
        const result: SearchResult = {
          electrode1: 0,
          electrode2: 0,
          amplitude: amp,
          sensorAvg1: 0,
          sensorAvg2: 0,
          effectiveness: 0,
          response: lastResponse || "N/A",
          timestamp: new Date().toLocaleTimeString("en-GB", { hour12: false }),
        };
        addResult(result);

        setCurrentStimPair(null);

        // Small gap between steps
        await delayMs(500);
      }

      addLog("Superelectrode Search completed.");
      setResults((prev) => {
        if (prev.length > 0) {
          const okResults = prev.filter((r) => r.response.toLowerCase().includes("ok"));
          const best = okResults.length > 0 ? okResults[0] : prev[prev.length - 1];
          setBestResult(best);
        }
        return prev;
      });
    } catch (err: any) {
      addLog(`Error: ${err.message || err}`);
    } finally {
      setIsRunning(false);
      isRunningRef.current = false;
      setCurrentStimPair(null);
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
        </div>
      </div>

      {/* Algorithm Description & Controls */}
      <div className={styles.algorithmSection}>
        <h3>{activeTab === "regular" ? "Regular Search" : "Superelectrode Algorithm"}</h3>
        <p className={styles.algorithmDescription}>
          {activeTab === "regular"
            ? "Loops through every electrode pair combination at each amplitude. For each test: starts sensors → stimulates → collects data → stops → analyses sensor response. Finds the best pair with the highest sensor response."
            : "Scans neighboring electrodes around a fixed anode to find optimal superelectrode combinations. Uses sensor feedback to compare cathode effectiveness."}
        </p>

        <div className={styles.statusBar}>
          <span className={`${styles.statusDot} ${isRunning ? styles.statusRunning : styles.statusIdle}`} />
          <span>{isRunning ? "Running..." : "Idle"}</span>
          {currentStimPair && (
            <span style={{ marginLeft: 16, fontWeight: 600 }}>
              Stimulating: Electrode {currentStimPair.e1} – {currentStimPair.e2}
              {currentAmplitude !== null && ` at ${currentAmplitude} mA`}
            </span>
          )}
          {isRunning && totalCombinations > 0 && (
            <span style={{ marginLeft: 16, color: "#999" }}>
              Progress: {electrodesTested}/{totalCombinations} ({Math.round((electrodesTested / totalCombinations) * 100)}%)
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
