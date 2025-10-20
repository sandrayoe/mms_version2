"use client";

import React, { createContext, useState, useContext, useRef, useEffect } from "react";

// Simplified Bluetooth context for sensor-only UI
interface BluetoothContextType {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  isConnected: boolean;
  sendCommand: (...args: (string | number)[]) => Promise<void>;
  imuData: { imu1_changes: number[]; imu2_changes: number[] };
  startIMU: () => Promise<void>;
  stopIMU: () => Promise<void>;
}

export const BluetoothContext = createContext<BluetoothContextType | undefined>(undefined);

export const BluetoothProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [device, setDevice] = useState<BluetoothDevice | null>(null);
  const [rxCharacteristic, setRxCharacteristic] = useState<BluetoothRemoteGATTCharacteristic | null>(null);
  const [txCharacteristic, setTxCharacteristic] = useState<BluetoothRemoteGATTCharacteristic | null>(null);

  const deviceRef = useRef<BluetoothDevice | null>(null);
  const isManualDisconnectRef = useRef(false);

  const [imuData, setImuData] = useState<{ imu1_changes: number[]; imu2_changes: number[] }>({ imu1_changes: [], imu2_changes: [] });
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
        await txChar.startNotifications();
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
  const maxHistory = 500;

  const handleIMUData = (rawBytes: Uint8Array) => {
    try {
      const dataView = new DataView(rawBytes.buffer);
      const sensor1Changes: number[] = [];
      const sensor2Changes: number[] = [];

      for (let i = 0; i < rawBytes.length; i += 4) {
        const sensor1Value = dataView.getUint16(i, true);
        const sensor2Value = dataView.getUint16(i + 2, true);
        const sensor1Delta = Math.abs(sensor1Value - IDLE_VALUE);
        const sensor2Delta = Math.abs(sensor2Value - IDLE_VALUE);
        sensor1Changes.push(sensor1Delta);
        sensor2Changes.push(sensor2Delta);
      }

      setImuData(prev => ({
        imu1_changes: [...prev.imu1_changes, ...sensor1Changes].slice(-maxHistory),
        imu2_changes: [...prev.imu2_changes, ...sensor2Changes].slice(-maxHistory),
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
      txCharacteristic.removeEventListener("characteristicvaluechanged", handleIncomingData);
      await txCharacteristic.stopNotifications();
    } catch (err) {
      console.error("Failed to stop IMU:", err);
    }
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
      stopIMU
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