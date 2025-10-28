"use server";

import React from "react";

const DocsPage: React.FC = () => {
  return (
    <div style={{ padding: 24, maxWidth: 980, margin: "0 auto", fontFamily: 'Segoe UI, Roboto, Arial, sans-serif' }}>
      <h1><b>MMS version 2 — Overview and notes</b></h1>

      <p style={{ marginTop: 8 }}>
        This page summarizes the current application features, how sensor values are
        extracted and processed, how the graphs render values, what the saved CSV files
        contain, and a few practical notes for both developers and users.
      </p>

      <section style={{ marginTop: 20 }}>
        <h2><b>1. Key features</b></h2>
        <ul>
          <li>a. Connect to the MMS Bluetooth device and receive sensor notifications.</li>
          <li>b. Parse binary sensor notifications into per-sensor numeric samples.</li>
          <li>c. Real-time plotting of two sensors with two zoom levels each (0–250 and 0–50).
            Charts are implemented with Recharts.</li>
          <li>d. Default time-binning/averaging of incoming samples (configurable BIN_MS; 0 if it is not required).</li>
          <li>e. Start/stop recording of the (binned) samples and download them as CSV, with parameter snapshots and markers included.</li>
        </ul>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>2. How sensor values are extracted (parsing)</b></h2>
        <p>
          Raw Bluetooth notifications are parsed in <code>src/app/BluetoothContext.tsx</code>.
          The important steps are:
        </p>
        <ol>
          <li> a.
            The notification payload is interpreted as a sequence of 16-bit unsigned integers
            (little-endian) — two values per sample pair. The implementation uses
            <code> DataView.getUint16(..., true)</code>.
          </li>
          <li> b. 
            Each raw value is converted to a magnitude by subtracting an IDLE offset and
            taking absolute value: <code>mag = Math.abs(raw - IDLE_VALUE)</code> where 
            <code> IDLE_VALUE</code> is 2048 in the current code.
          </li>
          <li> c. 
            The parser returns arrays of magnitudes for sensor1 and sensor2. No further
            clamping or scaling is applied in the parser, magnitudes are forwarded as-is.
          </li>
        </ol>

        <div style={{ marginTop: 8, padding: 12, background: '#f6f8fa', borderRadius: 6 }}>
          <strong>Notes on numeric range:</strong>
          <ul>
            <li>Because <code>getUint16</code> is used, the theoretical max raw value is 65535. With <code>IDLE_VALUE = 2048</code> the absolute theoretical magnitude limit is <code>65535 - 2048 = 63487</code>.</li>
            <li>However, I have checked that the hardware uses a smaller ADC (e.g. 12-bit values 0–4095). In that case the practical magnitude max would be ~2047. The code does not enforce this assumption.</li>
          </ul>
        </div>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>3. Timestamps and sample timing</b></h2>
        <p>
          Each parsed sample is assigned a timestamp based on <code>performance.now()</code>
          at the time the notification is handled. A small per-sample offset
          is applied so the relative ordering within a single notification is preserved.
          The provider exposes <code>imuData.imu1_changes</code> and <code>imuData.imu2_changes</code>
          arrays, where each item is <code>{'{'} value: number; ts: number {'}'}</code>.
        </p>
        <p>
          Windowing & assumed timing: the UI assumes an approximate sample interval (the code
          uses <code>sampleIntervalMs = 20</code> as a heuristic, i.e. ~50 Hz). The chart
          component displays a sliding window of the most recent <code>CHART_WINDOW_SIZE </code>
          samples (default <strong>200 samples</strong>), so the visible time span is roughly
          200 * 20 ms ≈ 4 seconds at the default assumptions. These numbers are configurable in
          <code> src/app/NMESControl.tsx</code> if you need a wider/narrower window or a different timebase.
        </p>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>4. How the graph reads and displays values</b></h2>
        <p>
          Graphing and display are handled by <code>src/app/NMESControl.tsx</code>. Important details:
        </p>
        <ul>
          <li>a. Polling: The UI polls the provider arrays at a fixed interval (the implementation batches work via <code>setInterval(..., 100)</code>, i.e. roughly every 100 ms) and slices newly appended samples to avoid reprocessing old ones. Batches are then flushed incrementally to the React state using requestAnimationFrame to keep rendering smooth.</li>
          <li>b. Binning & averaging: If <code>BIN_MS</code> is greater than 0 (default 20 ms), incoming samples are grouped in time bins of that width and averaged (both time and value are averaged). This reduces jitter and rendering churn. Set <code>BIN_MS = 0</code> to disable binning and keep raw samples.</li>
          <li>c. Incremental flush: parsed (or binned) samples are enqueued and flushed in small chunks per animation frame (the code uses <code>FLUSH_PER_FRAME</code>, default 8) to avoid long main-thread stalls when a large batch arrives.</li>
          <li>d. Visible window: charts keep only the most recent <code>CHART_WINDOW_SIZE</code> samples (default 200) to limit memory and rendering work; older samples are discarded from the in-memory chart buffers but remain available in recordings if you saved them.</li>
          <li>e. Rendering: averaged points are flushed to the charts incrementally via rAF to keep the UI responsive.</li>
          <li>f. Y-axis: charts use <code>CHART_Y_MAX = 250</code> for the main view and separate zoomed panels for 0–50. These are visual limits only — they do not modify stored values.</li>
          <li>g. Formatting: X axis and tooltips are formatted; Y axis ticks and tooltips are also visually rounded (e.g., 1–2 decimals) by the component code.</li>
        </ul>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>5. What is saved to CSV (recording format)</b></h2>
        <p>
          When recording is active the UI stores the binned/averaged points in a recording buffer. The CSV file produced by the Save action has the following structure:
        </p>
        <ul>
          <li>a. Header row: <code>time,sensor1,sensor2,frequency,level,intensity,motorPoints,position,pvv1,pvv2,pvv3,patientName,sensorName</code></li>
          <li>b. Rows: one row per recorded time point (the union of sensor1 and sensor2 times). If a sensor lacks a value at a time point the cell is left empty.</li>
          <li>c. Parameter snapshots: the code records parameter snapshots (frequency, motorPoints, position, PVVs, etc.) at times when the user applies them. For each CSV row the snapshot whose time is the latest ≤ row time is used to populate parameter columns.</li>
          <li>d. Markers: after the main CSV rows a small markers section is appended containing any start/stop markers recorded during the session. When you press the <em>Start Recording</em> button the app records a <code>{'{'} type: 'start' {'}'}</code> marker at the current chart time; when you press <em>Stop Recording</em> it appends a matching <code>{'{'} type: 'stop' {'}'}</code> marker. These markers are included in the CSV so you can easily align recordings to events in post-processing.</li>
        </ul>

        <div style={{ marginTop: 8, padding: 12, background: '#fff8e1', borderRadius: 6 }}>
          <strong>Example header:</strong>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
time,sensor1,sensor2,frequency,level,intensity,motorPoints,position,pvv1,pvv2,pvv3,patientName,sensorName
          </pre>
        </div>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>6. Important developer notes & common changes</b></h2>
        <ul>
          <li>
            a. Parser location: change parsing or apply clamping/normalization in <code>src/app/BluetoothContext.tsx</code> (class <code>SensorDataProcessor</code>).
          </li>
          <li>
            b. Binning: to change how samples are aggregated, edit <code>BIN_MS</code> in <code>src/app/NMESControl.tsx</code>. Set to <code>0</code> for raw recording.
          </li>
          <li>
            c. Visualization limits: modify <code>CHART_Y_MAX</code> to tune the main chart vertical scaling.
          </li>
          <li>
            d. Rounding & display: the charts now format Y ticks and tooltips visually — this does not change CSV precision. If you want to round values in recordings, apply rounding when building recorded samples (in the binning step).</li>
          <li>
            e. If you need units or calibration (e.g., convert ADC magnitudes to physical units), add a calibration factor in the parser so stored values are in physical units rather than raw magnitudes.
          </li>
        </ul>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>7. Troubleshooting & diagnostic tips</b></h2>
        <ul>
          <li>a. If the chart looks flat or values are all zeros: verify the device is sending notifications and the Bluetooth service/characteristic UUIDs match the device.</li>
          <li>b. To inspect raw per-notification samples, set <code>BIN_MS = 0</code> and enable logging in <code>BluetoothContext.handleIMUData</code>.</li>
          <li>c. CSV missing parameters: ensure you pressed <em>Input Parameters</em> (it records snapshots) before starting a recording, otherwise the latest UI values will be used as fallback.</li>
        </ul>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>8. Where to make changes (quick pointers)</b></h2>
        <ul>
          <li><code>src/app/BluetoothContext.tsx</code> — Bluetooth connection, parsing, per-sample timestamps.</li>
          <li><code>src/app/NMESControl.tsx</code> — UI polling, binning/averaging, charting, recording and CSV export.</li>
        </ul>
      </section>

      <div style={{ height: 28 }} />
      <div style={{ fontSize: 13, color: '#666' }}>
        Page source: <code>mms-appver2/src/app/docs/page.tsx</code> // last edited 28 Oct 2025.
      </div>
    </div>
  );
};

export default DocsPage;
