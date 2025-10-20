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

      for (let i = 0; i < pairCount; i++) {
        const off = i * 4;
        const raw1 = dv.getUint16(off, true);
        const raw2 = dv.getUint16(off + 2, true);
        s1[i] = Math.abs(raw1 - SensorDataProcessor.IDLE_VALUE);
        s2[i] = Math.abs(raw2 - SensorDataProcessor.IDLE_VALUE);
      }

      return { sensor1: s1, sensor2: s2 };
    }
  }

  const handleIMUData = (rawBytes: Uint8Array) => {
    try {
      const { sensor1, sensor2 } = SensorDataProcessor.processRawBytesAsMagnitudes(rawBytes);

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

      // Timestamp the notification and assign per-sample timestamps with a small offset
      // to preserve ordering within the notification. The offset is an estimate and can be
      // refined later or replaced by device-provided timestamps.
      const baseTs = performance.now();
      const estimatedSampleInterval = 7; // ms per sample (heuristic)

      const sensor1Samples: BluetoothSample[] = sensor1.map((v, idx) => ({
        value: v,
        ts: baseTs - (sensor1.length - 1 - idx) * estimatedSampleInterval,
      }));

      const sensor2Samples: BluetoothSample[] = sensor2.map((v, idx) => ({
        value: v,
        ts: baseTs - (sensor2.length - 1 - idx) * estimatedSampleInterval,
      }));

      setImuData(prev => ({
        imu1_changes: [...prev.imu1_changes, ...sensor1Samples],
        imu2_changes: [...prev.imu2_changes, ...sensor2Samples],
      }));
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

  return (
    <BluetoothContext.Provider value={{
      connect,
      disconnect,
      isConnected,
      sendCommand,
      imuData,
      startIMU,
      stopIMU,
      clearIMU
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