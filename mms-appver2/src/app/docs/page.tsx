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
          <li>f. Pause/resume recording. After recording started, the process can be paused and resumed, with the paused data will be discarded.</li>
          <li>g. Search Algorithm page: automatically test all electrode pair combinations to find the best motor points for NMES stimulation.</li>
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
        <p> Each incoming BLE notification is added to a queue immediately, tagged with <code>arrivalTs = performance.now()</code> to record its exact arrival time. Parsing is deferred to keep the message handler lightweight. When the queued item is later processed, its stored <code>arrivalTs</code> is used as the notification’s <code>baseTs</code> when assigning timestamps to individual samples. This ensures that real arrival timing is preserved even if processing is delayed by the queue. </p> 
        <p> Per-sample spacing is calculated from the measured time gap between consecutive notifications when available. If that information is missing, a default interval of <code>DEFAULT_SAMPLE_INTERVAL = 20&nbsp;ms</code> is used. All timestamps are rounded to integer milliseconds. The provider exposes <code>imuData.imu1_changes</code> and <code>imuData.imu2_changes</code> arrays, 
        where each element has the form <code>{'{'} value: number; ts: number {'}'}</code>, with <code>ts</code> measured in milliseconds from <code>performance.now()</code> at page load. To display human-readable wall-clock times in the UI, convert these timestamps to epoch time using <code>Date.now() - performance.now() </code> </p>
        <p>
          Windowing & assumed timing: the UI assumes roughly <code>sampleIntervalMs = 20</code>
          (≈50 Hz) when computing expected ranges. Charts keep a sliding window of the most
          recent <code>CHART_WINDOW_SIZE</code> samples (default 200). Adjust these values in
          <code>src/app/NMESControl.tsx</code> to change visible time span or timebase.
        </p>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>Deduplication & suppression</b></h2>
        <p>
          The provider performs two lightweight dedupe steps to avoid repeated identical
          spikes showing up in the charts:
        </p>
        <ol>
          <li>
            <strong>Raw-window debounce</strong>: a string hash of the raw 16-bit values
            (<code>raw1s.join(',') + '|' + raw2s.join(',')</code>) is compared against a
            recent map. If the same payload hash was seen within <code>DUP_WINDOW_MS</code>
            (default 250 ms) the whole notification is skipped from being appended.
          </li>
          <li>
            <strong>Tail-pair dedupe</strong>: when aligned sample pairs are drained into the
            React state the code checks the last appended pair and skips any new pair whose
            timestamps and values exactly match the previous pair. This prevents duplicate
            adjacent points after batching/draining.
          </li>
        </ol>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>4. How the graph reads and displays values</b></h2>
        <p>
          Graphing and display are handled by <code>src/app/NMESControl.tsx</code>. Important details:
        </p>
        <ul>
          <li>a. Polling: The UI polls the provider arrays at a fixed interval (the implementation batches work via <code>setInterval(..., 100)</code>, i.e. roughly every 100 ms) and slices newly appended samples to avoid reprocessing old ones. Batches are then flushed incrementally to the React state using requestAnimationFrame to keep rendering smooth.</li>
          <li>b. Binning & averaging: If <code>BIN_MS</code> is greater than, incoming samples are grouped in time bins of that width and averaged (both time and value are averaged). This reduces jitter and rendering churn. Set default <code>BIN_MS = 0</code> to disable binning and keep raw samples.</li>
          <li>c. Incremental flush: parsed (or binned) samples are enqueued and flushed in small chunks per animation frame (the code uses <code>FLUSH_PER_FRAME</code>, default 8) to avoid long main-thread stalls when a large batch arrives.</li>
          <li>d. Visible window: charts keep only the most recent <code>CHART_WINDOW_SIZE</code> samples (default 200) to limit memory and rendering work; older samples are discarded from the in-memory chart buffers but remain available in recordings if you saved them.</li>
          <li>e. Rendering: averaged points are flushed to the charts incrementally via rAF to keep the UI responsive.</li>
          <li>f. Y-axis: charts use <code>CHART_Y_MAX = 250</code> for the main view and separate zoomed panels for 0–50. These are visual limits only — they do not modify stored values.</li>
          <li>g. Formatting: X axis and tooltips are formatted; Y axis ticks are shown as integers in the current release (no trailing <code>.0</code>) while tooltips still show two decimals by default. These are presentation-only and do not change stored CSV precision.</li>
        </ul>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>5. What is saved to CSV (recording format)</b></h2>
        <p>
          When recording is active the UI stores the binned/averaged points in a recording buffer. The CSV file produced by the Save action has the following structure:
        </p>
        <ul>
          <li>a. Filename: taken from patientName, sensorName, and timestamps.</li>  
          <li>b. Header row: <code>time,sensor1,sensor2,frequency,level,intensity,motorPoints,position,pvv1,pvv2,pvv3,patientName,sensorName</code></li>
          <li>c. Rows: one row per recorded time point (the union of sensor1 and sensor2 times). If a sensor lacks a value at a time point the cell is left empty.</li>
          <li>d. Parameter snapshots: the code records parameter snapshots (frequency, motorPoints, position, PVVs, etc.) at times when the user applies them. For each CSV row the snapshot whose time is the latest ≤ row time is used to populate parameter columns.</li>
          <li>e. Markers: after the main CSV rows a small markers section is appended containing any start/stop markers recorded during the session. When you press the <em>Start Recording</em> button the app records a <code>{'{'} type: 'start' {'}'}</code> marker at the current chart time; when you press <em>Stop Recording</em> it appends a matching <code>{'{'} type: 'stop' {'}'}</code> marker. These markers are included in the CSV so you can easily align recordings to events in post-processing.</li>
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
            b. Queueing & throttling knobs: the provider was updated to enqueue incoming
            notifications and process them in small batches. See these symbols in
            <code>BluetoothContext.tsx</code>:
            <ul>
              <li><code>rawQueueRef</code> — incoming queue of {'{'} bytes, arrivalTs {'}'}</li>
              <li><code>PROCESS_MS</code>, <code>BATCH_PER_TICK</code> — raw-queue drain timing</li>
              <li><code>pairsRef</code>, <code>PENDING_CAP</code> — pending aligned pairs buffer</li>
              <li><code>DRAIN_MS</code>, <code>MAX_DRAIN_PER_TICK</code>, <code>DRAIN_CHUNK_SIZE</code> — chunked drain parameters to avoid long main-thread tasks</li>
              <li><code>VERBOSE_LOGGING</code> — set to true only for debugging to reduce console noise</li>
            </ul>
          </li>
          <li>
            c. Binning: to change how samples are aggregated, edit <code>BIN_MS</code> in <code>src/app/NMESControl.tsx</code>. Set to <code>0</code> for raw recording.
          </li>
          <li>
            d. Visualization limits: modify <code>CHART_Y_MAX</code> to tune the main chart vertical scaling.
          </li>
          <li>
            e. Rounding & display: the charts format Y ticks to integers for readability; tooltips show two decimals by default. This is presentation-only — CSVs keep full precision unless you explicitly round during binning.
          </li>
          <li>
            f. If you need units or calibration (e.g., convert ADC magnitudes to physical units), add a calibration factor in the parser so stored values are in physical units rather than raw magnitudes.
          </li>
          <li>
            g. Spike forensic log: the in-memory spike/burst forensic log was removed from the provider in this release (per user request). Offline forensic analysis remains possible via the CSV exports and external tools.
          </li>
        </ul>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>7. Troubleshooting & diagnostic tips</b></h2>
        <ul>
          <li>a. If the chart looks flat or values are all zeros: verify the device is charged (sufficiently) and is sending notifications. Otherwise, check the connections.</li>
          <li>b. To inspect raw per-notification samples, set <code>BIN_MS = 0</code> and enable logging in <code>BluetoothContext.handleIMUData</code> (set <code>VERBOSE_LOGGING = true</code> temporarily). You can also add a small dev overlay to show <code>rawQueueRef.current.length</code> and <code>pairsRef.current.length</code> to observe backlog while reproducing bursts.</li>
          <li>c. CSV missing parameters: ensure you pressed <em>Input Parameters</em> (it records snapshots) before starting a recording, otherwise the latest UI values will be used as fallback.</li>
        </ul>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>8. Search Algorithm — Finding the best electrode pair</b></h2>
        <p>
          The Search Algorithm page (<code>/search</code>) automatically tests every possible
          pair of electrodes to find which two produce the strongest muscle response.
          Think of it as a systematic trial-and-error process: the app sends a small
          electrical pulse through one pair at a time and measures how much the muscle moves
          using the motion sensors (IMU).
        </p>

        <h3 style={{ marginTop: 16 }}>How it works (Regular Search)</h3>
        <ol>
          <li>
            <strong>You choose the settings</strong> — minimum and maximum stimulation strength
            (amplitude in mA), a delay time (how long each pulse lasts), and how many
            electrodes are connected.
          </li>
          <li>
            <strong>The app calculates all possible pairs</strong> — for example, with 9
            electrodes there are 36 unique pairs (1-2, 1-3, … 8-9). Each pair is tested at
            every amplitude in the range you set.
          </li>
          <li>
            <strong>For each pair, the app</strong>:
            <ol type="a" style={{ marginTop: 4, marginLeft: 16 }}>
              <li>Clears any old sensor data</li>
              <li>Sends a &quot;start stimulation&quot; command to the device</li>
              <li>Waits for the delay period while the sensors record muscle movement</li>
              <li>Sends a &quot;stop stimulation&quot; command</li>
              <li>Looks at the sensor readings and calculates an <em>effectiveness score</em>
                (how much the sensor values deviated from rest — bigger = stronger response)</li>
            </ol>
          </li>
          <li>
            <strong>At the end</strong>, the app shows which pair produced the highest
            effectiveness score, along with the amplitude that worked best. This is the
            recommended motor point.
          </li>
        </ol>

        <h3 style={{ marginTop: 16 }}>Stimulation command format</h3>
        <p>
          The device uses a 6-byte binary command for stimulation (the <code>e</code> command):
        </p>
        <table style={{ borderCollapse: 'collapse', marginTop: 8, fontSize: 14 }}>
          <thead>
            <tr style={{ background: '#f0f0f0' }}>
              <th style={{ border: '1px solid #ccc', padding: '4px 10px' }}>Byte</th>
              <th style={{ border: '1px solid #ccc', padding: '4px 10px' }}>Meaning</th>
              <th style={{ border: '1px solid #ccc', padding: '4px 10px' }}>Range</th>
            </tr>
          </thead>
          <tbody>
            <tr><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>0</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>Command character</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>&apos;e&apos; (0x65)</td></tr>
            <tr><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>1</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>Amplitude (raw byte)</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>0–255</td></tr>
            <tr><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>2</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>Electrode 1 (anode)</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>1–32 (raw byte, not ASCII)</td></tr>
            <tr><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>3</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>Electrode 2 (cathode)</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>1–32 (raw byte, not ASCII)</td></tr>
            <tr><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>4</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>Go flag</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>0 = stop, 1 = start</td></tr>
            <tr><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>5</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>Super-electrode flag</td><td style={{ border: '1px solid #ccc', padding: '4px 10px' }}>0 (regular) or 1</td></tr>
          </tbody>
        </table>
        <p style={{ marginTop: 8, fontSize: 13, color: '#555' }}>
          <strong>Important:</strong> electrode numbers and amplitude are sent as raw binary
          bytes, <em>not</em> as ASCII text. For example, electrode 10 is sent as byte value
          0x0A, not the characters &quot;1&quot; and &quot;0&quot;.
        </p>

        <h3 style={{ marginTop: 16 }}>Firmware reset (every 25 pairs)</h3>
        <p>
          The device firmware has an internal limit and stops responding to stimulation
          commands after approximately 36 consecutive pairs. To work around this, the search
          automatically performs a reset every 25 pairs:
        </p>
        <ol>
          <li>Sends a stop-stimulation command (all zeros)</li>
          <li>Stops the motion sensors</li>
          <li>Sends the <code>N</code> command to reset the firmware</li>
          <li>Waits 500 ms for the device to settle</li>
          <li>Restarts the motion sensors and continues testing</li>
        </ol>

        <h3 style={{ marginTop: 16 }}>Effectiveness score</h3>
        <p>
          The effectiveness score is the <em>mean squared deviation from idle</em>. In simple
          terms: the app looks at all the sensor readings collected during a pulse and measures
          how far each reading is from the resting value. Larger deviations = the muscle moved
          more = better electrode placement. Both sensors are averaged together.
        </p>

        <h3 style={{ marginTop: 16 }}>Safety features</h3>
        <ul>
          <li><strong>Stop button:</strong> immediately stops stimulation and sensors at any time.</li>
          <li><strong>Abortable pauses:</strong> the delay between start and stop checks every 100 ms
            whether the user pressed Stop, so it reacts quickly.</li>
          <li><strong>Disconnect detection:</strong> if the Bluetooth connection drops mid-search,
            the algorithm stops automatically.</li>
          <li><strong>Emergency stop:</strong> on any error, the app sends a stop-stimulation command
            followed by a sensor-stop command.</li>
        </ul>

        <h3 style={{ marginTop: 16 }}>Superelectrode tab</h3>
        <p>
          The Superelectrode tab is a placeholder for a future search mode that tests
          super-electrode configurations (multiple electrodes activated together). This is not
          yet implemented.
        </p>

        <h3 style={{ marginTop: 16 }}>UI overview</h3>
        <ul>
          <li><strong>Parameters panel:</strong> set amplitude range, delay, and electrode count.</li>
          <li><strong>Progress bar:</strong> shows how many pairs have been tested out of the total.</li>
          <li><strong>Live status:</strong> shows which electrode pair is currently being stimulated and at what amplitude.</li>
          <li><strong>Log panel:</strong> scrollable real-time log of every test step, including effectiveness scores.</li>
          <li><strong>Best result card:</strong> after the search completes, shows the winning electrode pair, its amplitude, and effectiveness score.</li>
          <li><strong>Battery indicator:</strong> click to check device battery level.</li>
        </ul>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2><b>9. Where to make changes (quick pointers)</b></h2>
        <ul>
          <li><code>src/app/BluetoothContext.tsx</code> — Bluetooth connection, parsing, per-sample timestamps.</li>
          <li><code>src/app/NMESControl.tsx</code> — UI polling, binning/averaging, charting, recording and CSV export.</li>
          <li><code>src/app/search/SearchAlgorithm.tsx</code> — Search Algorithm page: electrode pair search loop, firmware reset logic, effectiveness calculation, and UI.</li>
          <li><code>src/app/search/SearchAlgorithm.module.css</code> — Styling for the Search Algorithm page.</li>
        </ul>
      </section>

      <div style={{ height: 28 }} />
      <div style={{ fontSize: 13, color: '#666' }}>
        Page source: <code>mms-appver2/src/app/docs/page.tsx</code> // last edited 25 Feb 2026.
      </div>
    </div>
  );
};

export default DocsPage;
