import React, { createContext, useState, useContext, useRef, useEffect } from "react";

// Define the Bluetooth context and its type
interface BluetoothContextType {
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    isConnected: boolean;
    sendCommand: (...args: string[]) => void;
    stopStimulation: () => Promise<void>;
    runOptimizationLoop: (
      updateCurrentPair: (pair: [number, number]) => void,
      updateBestPair: (pair: [number, number]) => void,
      updateCurrentValue: (current: number) => void,
      updateBestCurrent: (current: number) => void, 
      minCurrent: number, 
      maxCurrent: number
    ) => Promise<void>;
    stopOptimizationLoop: () => Promise<void>;
    imuData: { imu1_changes: number[]; imu2_changes: number[] };
    startIMU: () => void;
    stopIMU: () => void;
    isOptimizationRunning: boolean; 
    initializeDevice: () => void; 
}

// Create the context
export const BluetoothContext = createContext<BluetoothContextType | undefined>(undefined);

export const BluetoothProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [device, setDevice] = useState<BluetoothDevice | null>(null);
  const [rxCharacteristic, setRxCharacteristic] = useState<BluetoothRemoteGATTCharacteristic | null>(null);
  const [txCharacteristic, setTxCharacteristic] = useState<BluetoothRemoteGATTCharacteristic | null>(null);

  const deviceRef = useRef<BluetoothDevice | null>(null);
  const isManualDisconnectRef = useRef(false);

  const isInitializingRef = useRef<boolean>(false);

  const isOptimizationRunningRef = useRef(false); 
  const [isOptimizationRunning, setIsOptimizationRunning] = useState(false);

  const [imuData, setImuData] = useState<{ imu1_changes: number[]; imu2_changes: number[] }>({
    imu1_changes: [],
    imu2_changes: []
  });
  const imuDataRef = useRef(imuData);
  useEffect(() => {
    imuDataRef.current = imuData;
  }, [imuData]);

  // Bluetooth service & characteristic UUIDs
  const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"; // Nordic UART Service
  const RX_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // Write characteristic (Send)
  const TX_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // Notify characteristic (Receive)

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

      if (!rxChar) {
        console.error("❌ RX characteristic not found! Check UUID.");
      } else {
          console.log("✅ RX Characteristic Found.");
      }

      if (!txChar) {
          console.error("❌ TX characteristic not found! Check UUID.");
      } else {
          console.log("✅ TX Characteristic Found. Starting notifications...");
          await txChar.startNotifications();
          txChar.addEventListener("characteristicvaluechanged", handleIncomingData);
      }

      setRxCharacteristic(rxChar || null);
      setTxCharacteristic(txChar || null);
      setDevice(selectedDevice);
      deviceRef.current = selectedDevice;
      setIsConnected(true);

      console.log("✅ Connected to:", selectedDevice.name);
      selectedDevice.addEventListener("gattserverdisconnected", handleDisconnection);
    } catch (error) {
      console.error("❌ Bluetooth connection failed:", error);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (deviceRef.current) {
      isManualDisconnectRef.current = true;
      deviceRef.current.removeEventListener("gattserverdisconnected", handleDisconnection);

      if (deviceRef.current.gatt?.connected) {
        deviceRef.current.gatt.disconnect();
        console.log("🔌 Device disconnected manually");
      }

      setIsConnected(false);
      setDevice(null);
      isManualDisconnectRef.current = false;
    }
  };

  // Handle unexpected disconnection
  const handleDisconnection = () => {
    if (isManualDisconnectRef.current) return;
    console.log("⚠️ Device disconnected unexpectedly");
    setIsConnected(false);
    setDevice(null);
  };
  
  const IDLE_VALUE = 2048;  // idle value for IMU
  let pendingResolve: ((data: string) => void) | null = null;

  const handleCommandResponse = (message: string) => {
    console.log("📩 Command response received:", message);
    if (pendingResolve) {
        let resolver = pendingResolve;
        pendingResolve = null; 
        resolver(message);
    }
  };

  const maxHistory = 500; // max history for the IMU data

  const handleIMUData = (rawBytes: Uint8Array) => {

    try {
      const dataView = new DataView(rawBytes.buffer);
      const sensor1Changes: number[] = [];
      const sensor2Changes: number[] = [];

      for (let i = 0; i < rawBytes.length; i += 4) {
          const sensor1Value = dataView.getUint16(i, true);
          const sensor2Value = dataView.getUint16(i + 2, true);

          // Calculate change (delta) from idle value
          const sensor1Delta = Math.abs(sensor1Value - IDLE_VALUE);
          const sensor2Delta = Math.abs(sensor2Value - IDLE_VALUE);

          sensor1Changes.push(sensor1Delta);
          sensor2Changes.push(sensor2Delta);
    }
    // Update IMU state separately
    setImuData(prev => ({
      imu1_changes: [...prev.imu1_changes, ...sensor1Changes].slice(-maxHistory),
      imu2_changes: [...prev.imu2_changes, ...sensor2Changes].slice(-maxHistory)
    }));

    } catch (error) {
      console.error("❌ Error processing IMU data:", error);
    }
      
  };

  const handleIncomingData = (event: any) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    if (!target || !target.value) {
        console.warn("⚠️ Received event without a valid value.");
        return;
    }
    const value = target.value;
    const rawBytes = new Uint8Array(value.buffer);
    //console.log("📩 Incoming BLE data:", new TextDecoder().decode(event.target.value.buffer));

    if (isInitializingRef.current) {
      let message = new TextDecoder().decode(rawBytes);
      handleCommandResponse(message);
      return; 
    } 

    handleIMUData(rawBytes);
  };


  // Start IMU data streaming
  const startIMU = async () => {
      console.log("IMU Started");

      if (!txCharacteristic) {
          console.error("❌ TX characteristic not found!");
          return;
      }

      try {
          await sendCommand("b"); // Start IMU data streaming from the device
          txCharacteristic.addEventListener("characteristicvaluechanged", handleIncomingData);
          await txCharacteristic.startNotifications();
          console.log("✅ Listening for IMU data...");
      } catch (error) {
          console.error("❌ Failed to start IMU:", error);
      }
  };

  // Stop IMU data streaming
  const stopIMU = async () => {
      console.log("IMU Stopped");

      if (!txCharacteristic) return;

      try {
          await sendCommand("B"); // Stop IMU data streaming from the device
          txCharacteristic.removeEventListener("characteristicvaluechanged", handleIncomingData);
          await txCharacteristic.stopNotifications();
      } catch (error) {
          console.error("❌ Failed to stop IMU:", error);
      }
  };

  const sendCommand = async (...args: (string | number)[]) => {
    if (!rxCharacteristic) {
        console.error("❌ RX characteristic not found!");
        return;
    }

    const commandBytes = new Uint8Array(
        args.flatMap(arg =>
            typeof arg === "number"
                ? [arg & 0xFF] // Send number as a raw byte
                : typeof arg === "string"
                ? arg.split("").map(char => char.charCodeAt(0)) // Convert string to ASCII
                : []
        )
    );
    //console.log(`📤 Sending Command as Raw Bytes:`, commandBytes);
    await rxCharacteristic.writeValue(commandBytes);
};


  const stopStimulation = async () => {
    await sendCommand("E", "0", "0", "0", "0", "0"); //command to stop the stimulation in CU
  };

  // extra function for the response if there are some parameters' changes in CU
  function waitForDeviceResponse(expectedCmd: string, delay: number = 1000): Promise<string> {
    return new Promise((resolve) => {
        const expected = expectedCmd.trim().toLowerCase();
        let resolved = false;

        const timeoutId = setTimeout(() => {
            if (!resolved) {
                resolve("No response received");
            }
        }, delay);

        const handleResponse = (response: string) => {
            if (!resolved) {
                clearTimeout(timeoutId);
                const resp = response.trim().toLowerCase();
                resolved = true;
                resolve(resp.startsWith(expected) ? response : `Unexpected response: ${response}`);
            }
        };

        //pendingResolve = handleResponse; // Store the function for use when response arrives
    });
  }

  const initializationConfig = [
    { cmd: "f", value: 32 },  // frequency
    //{ cmd: "d", value: 7 }, // phase duration
    { cmd: "o", value: 5 },   // ON time
    { cmd: "O", value: 10 },   // OFF time
    { cmd: "r", value: 0 },  // ramp-up time
    { cmd: "R", value: 0 }    // ramp-down time
  ];

  // Initialize device parameters (that need to be set)
  const initializeDevice = async() =>{

    if (!txCharacteristic) {
      console.error("❌ TX characteristic not found!");
      return;
    }

    try {
        isInitializingRef.current = true;
        console.log("Initializing device parameters...");
        const padValue = (num: number): string => num < 10 ? "0" + num : num.toString();
    
        for (const { cmd, value } of initializationConfig) {
          console.log(`Sending command '${cmd}'`);
          const responsePromise = waitForDeviceResponse(cmd, 1000);
          await sendCommand(cmd, padValue(value), "0");
          await responsePromise;
        }
    
        await sendCommand("s");
        isInitializingRef.current = false;
        await new Promise((res) => setTimeout(res, 500));

    } catch (error) {
        console.error("❌ Failed to initialize:", error);
    }
  }

    // Wavelet-based transformation using Haar wavelet
    function waveletTransform(window: number[], levels: number = 3): number[] {
      let coeffs = window.slice();

      for (let level = 0; level < levels; level++) {
        const temp: number[] = [];
        const half = coeffs.length / 2;

        for (let i = 0; i < half; i++) {
          const avg = (coeffs[2 * i] + coeffs[2 * i + 1]) / Math.sqrt(2);
          const diff = (coeffs[2 * i] - coeffs[2 * i + 1]) / Math.sqrt(2);
          temp[i] = avg;
          temp[half + i] = diff;
        }

        coeffs = temp.slice(0, coeffs.length);
      }

      return coeffs;
    }

    function extractD3D2Energy(window: number[], levels: number = 3): number {
      const waveletCoeffs = waveletTransform(window, levels);
    
      const coeffLength = waveletCoeffs.length;
      const sizeA3 = coeffLength / Math.pow(2, levels);;  
      const sizeD3 = sizeA3;
      const sizeD2 = sizeA3 * 2;
    
      const startD3 = sizeA3;
      const endD3 = startD3 + sizeD3;
      const startD2 = endD3;
      const endD2 = startD2 + sizeD2;
    
      const d3Coeffs = waveletCoeffs.slice(startD3, endD3);
      const d2Coeffs = waveletCoeffs.slice(startD2, endD2);
    
      // Energy = sum of absolute values raised to the power of 'p'
      const p = 1.5; // You can adjust this value to control the amplification
      const energyD3 = d3Coeffs.reduce((sum, x) => sum + Math.pow(Math.abs(x), p), 0);
      const energyD2 = d2Coeffs.reduce((sum, x) => sum + Math.pow(Math.abs(x), p), 0);
    
      // Combine them with a weight, or equally if unsure
      const combinedEnergy = 1.0 * energyD3 + 0.0 * energyD2;
    
      return combinedEnergy;
    }

    // Helper function to create a combined electrode stats tracker
    interface ElectrodeStats {
      usage: number;
      aggregatedScore: number;
      scores: number[];
      averageScore: number; 
      ewmaScore: number;
    }
    
    const createElectrodeStatsTracker = (numElectrodes: number): Record<number, ElectrodeStats> => {
      const tracker: Record<number, ElectrodeStats> = {};
      for (let i = 1; i <= numElectrodes; i++) {
        tracker[i] = {
          usage: 0,
          aggregatedScore: 0,
          scores: [],
          averageScore: 0,
          ewmaScore: 0,
        };
      }
      return tracker;
    };
    
    const updateElectrodeStats = (
      tracker: Record<number, ElectrodeStats>,
      pair: [number, number],
      pairScore: number,
    ): void => {
      pair.forEach(electrode => {
        const stats = tracker[electrode];
        stats.usage++;
        
        // Update EWMA
        if (stats.usage === 1) {
          //Initialize EWMA with the first score
          stats.ewmaScore = pairScore;
        } else {
          stats.ewmaScore = 1.0 * pairScore + 0.0 * stats.ewmaScore;
        }

        stats.scores.push(pairScore);
        stats.aggregatedScore += stats.ewmaScore;
        stats.averageScore = stats.aggregatedScore / stats.usage;
      });
    };
    

    const runOptimizationLoop = async (
      updateCurrentPair: (pair: [number, number]) => void,
      updateBestPair: (pair: [number, number]) => void,
      updateCurrentValue: (current: number) => void,
      updateBestCurrent: (current: number) => void,
      minCurrent: number,
      maxCurrent: number
    ) => {
      console.log("Starting SES Optimization with locked current phase...");
      setIsOptimizationRunning(true);
      isOptimizationRunningRef.current = true;
      await startIMU();
      await new Promise((res) => setTimeout(res, 500)); // Allow time for IMU data to populate
    
      // Generate unique electrode pairs (9 electrodes → 36 pairs)
      const electrodePairs: [number, number][] = [];
      const numElectrodes = 2;
      for (let i = 1; i <= numElectrodes; i++) {
        for (let j = i + 1; j <= numElectrodes; j++) {
          electrodePairs.push([i, j]);
        }
      }
      const numPairs = electrodePairs.length;

      const capturedIMUData: { imu1: number[], imu2: number[] }[] = []
    
      // === SES PARAMETERS ===
      const numIterations = 100; // Maximum iterations for phase 1
      const gradientStabilityThreshold = 15.0;      // threshold for "best pair" in phase 1
      const finalPerformanceThreshold = 30.0;     // threshold for final current in phase 1
    
      // === INITIALIZATION ===
      let currentPairIndex = Math.floor(Math.random() * numPairs);
      let I_k = minCurrent;
      let bestPairFound = false;
      let bestPair: [number, number] = [3, 4]; // default for beginning

      console.log(`Phase 1: Starting with Pair: ${electrodePairs[currentPairIndex]}, Current: ${I_k}mA`);

      if (minCurrent == maxCurrent) { 
        console.log("⚠️ Current level fixed. Skipping Phase 1.");
      } else {

      let justFoundBestPair = false; 
      let firstTimeBestPairFound = false;

      // Phase 1: Optimize current level until gradient threshold is reached
      for (let iteration = 0; iteration < numIterations && isOptimizationRunningRef.current; iteration++) {
        // --- Stochastic Perturbations ---
        let newPair = electrodePairs[currentPairIndex];
        let performance = 0; 
  

        if (!bestPairFound) {
          const eta_noise_pair = Math.sqrt(0.7) * (Math.random() - 0.5);
          currentPairIndex = Math.floor(
            Math.max(0, Math.min(numPairs - 1, currentPairIndex + eta_noise_pair * numPairs))
          );
          newPair = electrodePairs[currentPairIndex];
          bestPair = newPair;

          // Randomly perturb current level
          const eta_noise_current = Math.sqrt(0.7) * (Math.random() - 0.5);
          I_k = Math.round(Math.max(minCurrent, Math.min(maxCurrent, I_k + eta_noise_current * (maxCurrent - minCurrent))));
          firstTimeBestPairFound = true; 
        } else {
          newPair = bestPair; 
          if (firstTimeBestPairFound) {
            I_k = minCurrent; // start fresh
            firstTimeBestPairFound = false; 
          } else {
            if (I_k >= maxCurrent) {
              console.log("⚠️ Max current reached — stopping optimization.");
              break;
            }
            I_k = Math.min(I_k + 1, maxCurrent);
          }
        }

        updateCurrentValue(I_k);
        updateCurrentPair(newPair);
        I_k = 20; 

        // Send parameters to BLE and UI
        await sendCommand("E", I_k, newPair[0], newPair[1], 1, 0);
        await new Promise((res) => setTimeout(res, 700));

        const imu1 = imuDataRef.current.imu1_changes;
        const imu2 = imuDataRef.current.imu2_changes;

        // Discard the first 3 readings after stimulation
        const cleanedIMU1 = imu1.slice(-12).slice(4);
        const cleanedIMU2 = imu2.slice(-12).slice(4);
        //console.log("Cleaned IMU1:", cleanedIMU1, "Length:", cleanedIMU1.length);

        const energy = Math.max(
          extractD3D2Energy(cleanedIMU1),
          extractD3D2Energy(cleanedIMU2)
        );

        // --- Measure Response ---
        //const recentIMU1 = imuDataRef.current.imu1_changes.slice(-8);
        //const recentIMU2 = imuDataRef.current.imu2_changes.slice(-8);
        //const energy = Math.max(extractD3D2Energy(recentIMU1), extractD3D2Energy(recentIMU2));

        performance = energy;
        console.log(`Performance estimate: ${performance}`);

        // Stop if threshold met
        if (!bestPairFound) {
          if (performance >= gradientStabilityThreshold) {
            console.log("✅ Best pair found — switching to current optimization only.");
            bestPairFound = true;
            justFoundBestPair = true; // mark transition
          }
        } else if (!justFoundBestPair) {
          // Only start checking final threshold in iterations *after* the switch
          if (performance >= finalPerformanceThreshold) {
            console.log("✅ Final performance threshold met — stopping optimization.");
            break;
          }
        } else {
          // Clear the flag so that next iteration can check final threshold
          justFoundBestPair = false;
        }
      }
    }
    
      // --- Phase 2: Electrode Stats Update with Locked Current ---
      const statsTracker = createElectrodeStatsTracker(numElectrodes); 

      while (isOptimizationRunningRef.current) {
        // Randomly perturb the electrode pair index
        // Uniformly sample from all pairs each iteration
        const randomPairIndex = Math.floor(Math.random() * electrodePairs.length);
        const newPair = electrodePairs[randomPairIndex];
        
        console.log(`Phase 2: Sending Pair (${newPair[0]}, ${newPair[1]}) at ${I_k}mA`);
        updateCurrentPair(newPair);
        await sendCommand("E", I_k, newPair[0], newPair[1], 1, 0);
        //await sendCommand("e", I_k, 1, 2, 1, 0);
        await new Promise((res) => setTimeout(res, 700));
        
        // Measure activation using recent IMU data
        //const windowSize = 8;
        //const recentIMU1 = imuDataRef.current.imu1_changes.slice(-windowSize);
        //const recentIMU2 = imuDataRef.current.imu2_changes.slice(-windowSize);

        //capturedIMUData.push({
          //imu1: [...recentIMU1],
          //imu2: [...recentIMU2]
        //});

        //const energyIMU1 = extractD3D2Energy(recentIMU1);
        //const energyIMU2 = extractD3D2Energy(recentIMU2);
        //const newActivation = Math.max(energyIMU1, energyIMU2);
        
        const imu1 = imuDataRef.current.imu1_changes;
        const imu2 = imuDataRef.current.imu2_changes;

        // Discard the first 3 readings after stimulation
        const cleanedIMU1 = imu1.slice(-12).slice(3);
        const cleanedIMU2 = imu2.slice(-12).slice(3);

        const energy = Math.max(
          extractD3D2Energy(cleanedIMU1),
          extractD3D2Energy(cleanedIMU2)
        );

        const pairScore = energy;

        updateElectrodeStats(statsTracker, newPair, pairScore);

        // === Stopping Condition Check ===
        const allElectrodesTriedMinimumTimes = Object.values(statsTracker).every(
          (stat) => stat.usage >= 7
        );

        if (allElectrodesTriedMinimumTimes) {
          const sortedElectrodes = Object.entries(statsTracker)
            .map(([electrode, stats]) => ({
              electrode: Number(electrode),
              averageScore: stats.averageScore,
            }))
            .sort((a, b) => b.averageScore - a.averageScore);
        
          if (sortedElectrodes.length >= 6) {
            const top4 = sortedElectrodes.slice(0, 4);
            const bestPair: [number, number] = [top4[0].electrode, top4[1].electrode];
            console.log("✅ Stopping Phase 2. Top 4:", top4[0].electrode, top4[1].electrode, top4[2].electrode, top4[3].electrode);
            updateBestPair(bestPair);
            updateBestCurrent(I_k);
            break;
          }
        }        
      }

      // Send the final electrode stats to a backend
      console.log("Final electrode stats after locked phase:", statsTracker);
      try {
        const response = await fetch("http://localhost:5000/save-electrode-stats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(statsTracker),
        });
        const data = await response.json();
        console.log(data.message);
      } catch (error) {
        console.error("Error sending electrode stats:", error);
      }

      await stopOptimizationLoop();

      //await fetch("http://localhost:5000/save-raw-imu", {
        //method: "POST",
        //headers: { "Content-Type": "application/json" },
        //body: JSON.stringify(capturedIMUData),
      //});
    };
  
    const stopOptimizationLoop = async () => {
        isOptimizationRunningRef.current = false; 
        setIsOptimizationRunning(false);
        await stopStimulation();
    }; 

  return (
    <BluetoothContext.Provider value={{
      connect,
      disconnect,
      isConnected,
      sendCommand,
      stopStimulation,
      runOptimizationLoop,
      stopOptimizationLoop,
      imuData,
      startIMU,
      stopIMU,
      isOptimizationRunning, 
      initializeDevice 
    }}>
      {children}
    </BluetoothContext.Provider>
  );
};

export const useBluetooth = () => {
  const context = useContext(BluetoothContext);
  if (!context) {
    throw new Error("useBluetooth must be used within a BluetoothProvider");
  }
  return context;
};