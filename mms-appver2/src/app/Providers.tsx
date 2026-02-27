"use client";

import React from "react";
import { BluetoothProvider } from "./BluetoothContext";

export default function Providers({ children }: { children: React.ReactNode }) {
  return <BluetoothProvider>{children}</BluetoothProvider>;
}
