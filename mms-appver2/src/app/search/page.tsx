import SearchAlgorithm from "./SearchAlgorithm";
import { BluetoothProvider } from "../BluetoothContext";

export default function SearchPage() {
  return (
    <BluetoothProvider>
      <SearchAlgorithm />
    </BluetoothProvider>
  );
}
