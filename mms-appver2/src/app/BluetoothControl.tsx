import React, { useEffect } from 'react';
import { useBluetooth } from './BluetoothContext';  
import styles from './NMESControlPanel.module.css';

export const BluetoothControl: React.FC = () => {
  const { connect, disconnect, isConnected } = useBluetooth(); 

  return (
    <div className={styles.buttonContainer}>
      <button className={styles.button} onClick={connect} disabled={isConnected}>
        {isConnected ? "Connected" : "Connect"}
      </button>
      <button className={styles.button} onClick={disconnect} disabled={!isConnected}>
        {isConnected ? "Disconnect" : "Disconnected"}
      </button>
    </div>
  );
};

export default BluetoothControl
