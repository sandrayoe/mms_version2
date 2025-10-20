"use client";

import React, { useState, useEffect, useRef } from "react";
import { useBluetooth } from "./BluetoothContext";
import BluetoothControl from "./BluetoothControl";
import styles from "./NMESControl.module.css";
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend } from "recharts";

const SensorPanel: React.FC = () => {
  const { isConnected, imuData, startIMU, stopIMU } = useBluetooth();

  const [sensor1Data, setSensor1Data] = useState<{ time: number; sensorValue: number }[]>([]);
  const [sensor2Data, setSensor2Data] = useState<{ time: number; sensorValue: number }[]>([]);

  const [isMeasuring, setIsMeasuring] = useState(false);
  const sampleCountRef = useRef(0);

  // Update sensor values periodically when measuring
  useEffect(() => {
    if (isConnected && isMeasuring) {
      const interval = setInterval(() => {
        sampleCountRef.current++;

        const rawSensor1 = imuData.imu1_changes.length > 0 ? imuData.imu1_changes[imuData.imu1_changes.length - 1] : 0;
        const rawSensor2 = imuData.imu2_changes.length > 0 ? imuData.imu2_changes[imuData.imu2_changes.length - 1] : 0;

        setSensor1Data((prevData) => [
          ...prevData.slice(-199),
          { time: sampleCountRef.current, sensorValue: rawSensor1 }
        ]);

        setSensor2Data((prevData) => [
          ...prevData.slice(-199),
          { time: sampleCountRef.current, sensorValue: rawSensor2 }
        ]);

      }, 100); // Update every 100ms

      return () => clearInterval(interval);
    }
  }, [isConnected, isMeasuring, imuData]);

  const handleStartIMU = () => {
    setIsMeasuring(true);
    startIMU();
  };

  const handleStopIMU = () => {
    setIsMeasuring(false);
    stopIMU();
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <img src="/mms_logo_2.png" className={styles.logo} />
        <h1 className={styles.heading}>MMS - Sensor Readings</h1>
      </div>

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
            <div className={styles.buttonContainer}>
              <button className={styles.button} onClick={handleStartIMU} disabled={!isConnected || isMeasuring}>
                Start Sensor(s)
              </button>
              <button className={styles.button} onClick={handleStopIMU} disabled={!isConnected || !isMeasuring}>
                Stop Sensor(s)
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
                    <XAxis dataKey="time" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="sensorValue" stroke="#8884d8" strokeWidth={2} name="Sensor 1" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className={styles.chartContainer}>
                <h3>Sensor 2 Readings </h3>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={sensor2Data}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="time" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="sensorValue" stroke="#82ca9d" strokeWidth={2} name="Sensor 2" />
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





