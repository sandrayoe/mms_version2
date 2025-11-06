This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## IMU processing pipeline (implementation notes)

This project receives IMU notifications over BLE and runs a small processing
pipeline in the client to produce the time-aligned data shown in the charts.
The implementation lives in `src/app/BluetoothContext.tsx`. The notes below
describe the current behavior, tunable knobs, and how to verify/adjust it.

Key concepts
- Parsing: `SensorDataProcessor.processRawBytesAsMagnitudes` converts the
	incoming ArrayBuffer/Uint8Array into two arrays of magnitudes (`sensor1`,
	`sensor2`) and the raw 16-bit values (`raw1s`, `raw2s`). Each pair of bytes
	in the buffer corresponds to a sample for each sensor.
- Arrival timestamps: when a BLE notification is received we immediately
	enqueue it with an `arrivalTs = performance.now()` so timestamps reflect
	real arrival time even if processing is deferred.
- Per-sample timestamps: in `handleIMUData` the `arrivalTs` becomes the
	notification `baseTs`. Samples are spread backwards from `baseTs` using a
	per-sample interval (measured from the gap between notifications when
	possible, otherwise a conservative default). All timestamps are rounded to
	integer milliseconds for alignment.
- Alignment: samples from the two sensors are aligned by their rounded ms
	timestamps and only pairs that exist in both channels are appended. This
	keeps the two channels synchronized for display.

Deduplication and suppression
- Raw-window debounce (first stage): a lightweight raw-hash is computed from
	`(raw1s.join(',') + '|' + raw2s.join(','))`. If the same raw-hash appeared
	within `DUP_WINDOW_MS` (default 250 ms) the entire notification is treated
	as a duplicate and skipped from display.
- Tail-pair dedupe (second stage): when the pending aligned pairs are drained
	into React state a last-sample comparison prevents appending pairs that are
	identical to the previously appended pair. This avoids repeated identical
	points showing in the chart.

Queueing and UI throttling (performance)
- Incoming notifications are enqueued in `rawQueueRef` to avoid doing heavy
	parsing inside the BLE message handler. The queue items are objects
	`{ bytes: Uint8Array, arrivalTs: number }`.
- `processRawQueue` drains the raw queue in small batches every `PROCESS_MS`
	(default 12 ms) processing `BATCH_PER_TICK` notifications per tick.
- Parsed, aligned pairs are pushed into `pairsRef` (the pending pairs
	buffer). To avoid long, blocking React updates a chunked drain runs every
	`DRAIN_MS` (default 33 ms ~ 30Hz) and processes up to `MAX_DRAIN_PER_TICK`
	items in smaller `DRAIN_CHUNK_SIZE` chunks. Each chunk is appended with a
	`setImuData` call and the loop yields between chunks via `setTimeout(..., 0)`.

Important runtime knobs
- `PROCESS_MS` — delay between raw-queue processing ticks. Smaller = lower
	latency, more CPU work.
- `BATCH_PER_TICK` — how many notifications to parse per processing tick.
- `PENDING_CAP` — maximum number of pending aligned pairs kept in `pairsRef`.
- `DRAIN_MS` — how often the chunked drain runs (controls update frequency).
- `MAX_DRAIN_PER_TICK` and `DRAIN_CHUNK_SIZE` — bound the per-interval work
	and chunk size to prevent long tasks and rAF violations.
- `VERBOSE_LOGGING` — gate for non-error console output. Set to `true` only
	when debugging devices.

Behavioral notes and trade-offs
- Timestamps use `performance.now()` (monotonic, high-resolution). If you
	need wall-clock labels convert perf timestamps to epoch by adding
	`Date.now() - performance.now()`.
- The chunked drain reduces long-task violations in devtools but introduces
	a small, bounded latency (DRAIN_MS and chunks). These knobs trade latency
	for main-thread responsiveness.
- The in-memory spike/burst forensic log was removed from the provider by
	design. Offline forensic analysis is still possible with exported CSVs
	produced by the UI's recording feature.

How to verify and tune
1. Instrument: temporarily set `VERBOSE_LOGGING = true` in
	 `BluetoothContext.tsx` and inspect `rawQueueRef.current.length` and
	 `pairsRef.current.length` (console or small dev overlay) while reproducing
	 bursts from the device.
2. Reduce `MAX_DRAIN_PER_TICK` or `DRAIN_CHUNK_SIZE` if you still see
	 long `requestAnimationFrame` or `[Violation]` warnings in devtools.
3. Increase `BATCH_PER_TICK` or `PROCESS_MS` if the raw queue grows too
	 large; moving parsing to a Web Worker is recommended for sustained high
	 throughput.

Files / symbols to look at
- `src/app/BluetoothContext.tsx` — parser, queueing, dedupe, chunked drain
- `src/app/NMESControl.tsx` — charting and CSV export (converts perf ts to
	session-relative seconds for plotting)
