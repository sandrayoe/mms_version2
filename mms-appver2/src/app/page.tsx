import SensorPanel from './NMESControl';
import { BluetoothProvider } from './BluetoothContext';

export default function Home() {
  return (
    <BluetoothProvider>
      <SensorPanel />
    </BluetoothProvider>
  );
}
