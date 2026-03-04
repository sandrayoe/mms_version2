/**
 * Signal analysis module — TypeScript port of the Python backend's
 * DFT-based effectiveness calculation, SNR, muscle activation detection,
 * and confidence-based best-pair determination.
 *
 * All processing runs in the browser — no server required.
 */

// ─── Constants ───

const SAMPLING_RATE = 50; // Hz (matches firmware IMU output rate)
const CUTOFF_FREQUENCY = 5; // Hz — muscle contractions are typically below 5 Hz
const ACTIVATION_THRESHOLD = 10; // Low-freq power threshold for muscle activation

// ─── Basic statistics ───

/** Compute the mean of an array of numbers. */
export function customMean(data: number[]): number {
  if (data.length === 0) return 0;
  return data.reduce((a, b) => a + b, 0) / data.length;
}

/** Compute the sample variance (Bessel-corrected) of an array of numbers. */
export function customVariance(data: number[]): number {
  const n = data.length;
  if (n < 2) return 0;
  const m = customMean(data);
  return data.reduce((sum, x) => sum + (x - m) ** 2, 0) / (n - 1);
}

// ─── Discrete Fourier Transform ───

/**
 * Compute the Discrete Fourier Transform (DFT) of a real-valued signal.
 * Returns an array of [re, im] tuples.
 *
 * O(N²) — fast enough for the small sample counts from the IMU (typically 25-100).
 */
export function dft(signal: number[]): [number, number][] {
  const N = signal.length;
  const result: [number, number][] = [];
  for (let k = 0; k < N; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const angle = (-2 * Math.PI * k * n) / N;
      re += signal[n] * Math.cos(angle);
      im += signal[n] * Math.sin(angle);
    }
    result.push([re, im]);
  }
  return result;
}

// ─── Signal metrics ───

/** Calculate Signal-to-Noise Ratio in dB. */
export function calculateSnr(signal: number[]): number {
  if (signal.length === 0) return 0;
  const signalMean = customMean(signal);
  const centered = signal.map((x) => x - signalMean);
  const signalPower = customMean(centered.map((x) => x ** 2));
  const noisePower = customVariance(centered);
  if (noisePower === 0) return 0;
  return 10 * Math.log10(signalPower / noisePower);
}

/**
 * Calculate the power in low frequencies (0 – cutoffFrequency Hz) via DFT.
 *
 * Steps:
 * 1. Detrend the signal (subtract mean).
 * 2. Compute DFT.
 * 3. Build single-sided magnitude spectrum.
 * 4. Sum squared magnitudes for frequency bins ≤ cutoff.
 */
export function calculateLowFreqPower(
  sensorData: number[],
  fs: number = SAMPLING_RATE,
  cutoffFrequency: number = CUTOFF_FREQUENCY
): number {
  if (sensorData.length === 0) return 0;

  const mean = customMean(sensorData);
  const detrended = sensorData.map((x) => x - mean);
  const fftResult = dft(detrended);
  const n = detrended.length;

  // Frequency bin centres
  const frequencies = Array.from({ length: n }, (_, k) => (fs * k) / n);

  // Single-sided magnitude spectrum (DC + positive frequencies)
  const rawMag = fftResult.map(([re, im]) => Math.sqrt(re ** 2 + im ** 2) / n);
  const halfN = Math.floor(n / 2);
  const fftMagnitude = [
    rawMag[0],
    ...rawMag.slice(1, halfN).map((x) => 2 * x),
  ];

  // Sum of squared magnitudes within the cutoff frequency
  let lowFreqPower = 0;
  for (let i = 0; i < fftMagnitude.length; i++) {
    if (i < frequencies.length && frequencies[i] >= 0 && frequencies[i] <= cutoffFrequency) {
      lowFreqPower += fftMagnitude[i] ** 2;
    }
  }

  return lowFreqPower;
}

/** Detect if muscle movement occurred based on low-frequency power exceeding a threshold. */
export function detectMuscleMovement(
  sensorData: number[],
  fs: number = SAMPLING_RATE,
  cutoffFrequency: number = CUTOFF_FREQUENCY,
  activationThreshold: number = ACTIVATION_THRESHOLD
): boolean {
  if (sensorData.length === 0) return false;
  return calculateLowFreqPower(sensorData, fs, cutoffFrequency) > activationThreshold;
}

// ─── Main effectiveness calculation ───

export interface EffectivenessResult {
  /** DFT-based low-frequency power (average of both sensors). */
  effectiveness: number;
  /** Average Signal-to-Noise Ratio across both sensors (dB). */
  avgSnr: number;
  /** Whether muscle activation was detected in either sensor. */
  activationDetected: boolean;
}

/**
 * Calculate effectiveness using DFT-based low-frequency power analysis.
 *
 * This replaces the simpler mean-squared-deviation approach with a
 * frequency-domain method that better isolates actual muscle contractions
 * (low-frequency movements) from high-frequency noise/artefacts.
 */
export function calculateEffectiveness(
  sensor1Data: number[],
  sensor2Data: number[],
  fs: number = SAMPLING_RATE
): EffectivenessResult {
  const snr1 = calculateSnr(sensor1Data);
  const snr2 = calculateSnr(sensor2Data);

  const movement1 = detectMuscleMovement(sensor1Data, fs);
  const movement2 = detectMuscleMovement(sensor2Data, fs);

  const avgSnr = snr1 > 0 || snr2 > 0 ? (snr1 + snr2) / 2 : 0;

  const lowFreqPower1 = calculateLowFreqPower(sensor1Data, fs);
  const lowFreqPower2 = calculateLowFreqPower(sensor2Data, fs);

  const effectiveness =
    lowFreqPower1 > 0 || lowFreqPower2 > 0
      ? (lowFreqPower1 + lowFreqPower2) / 2
      : 0;

  return { effectiveness, avgSnr, activationDetected: movement1 || movement2 };
}

// ─── Confidence metrics & best-pair determination ───

export interface PairData {
  anode: number;
  cathode: number;
  activationsInRow: number;
  activations: number;
  counts: number;
  totalSnr: number;
  totalEffectiveness: number;
  confidenceMetric: number;
}

export interface SearchTracker {
  pairData: PairData[];
  totalSnr: number;
  totalEffectiveness: number;
  activationRateAvg: number;
  combinations: number;
}

/** Create a fresh search tracker. */
export function createSearchTracker(): SearchTracker {
  return {
    pairData: [],
    totalSnr: 0,
    totalEffectiveness: 0,
    activationRateAvg: 0,
    combinations: 0,
  };
}

/** Update electrode pair data with a new measurement (mutates tracker in place). */
export function updateElectrodeData(
  tracker: SearchTracker,
  effectiveness: number,
  avgSnr: number,
  activationDetected: boolean,
  anode: number,
  cathode: number
): void {
  let pairFound = false;
  for (const pair of tracker.pairData) {
    if (pair.anode === anode && pair.cathode === cathode) {
      pair.activationsInRow = activationDetected ? pair.activationsInRow + 1 : 0;
      pair.activations = activationDetected ? pair.activations + 1 : pair.activations;
      pair.counts += 1;
      pair.totalSnr += avgSnr;
      pair.totalEffectiveness += effectiveness;
      pairFound = true;
      break;
    }
  }

  if (!pairFound) {
    tracker.pairData.push({
      anode,
      cathode,
      activationsInRow: activationDetected ? 1 : 0,
      activations: activationDetected ? 1 : 0,
      counts: 1,
      totalSnr: avgSnr,
      totalEffectiveness: effectiveness,
      confidenceMetric: 0,
    });
  }
}

/** Calculate per-pair confidence metric (internal helper). */
function calculateConfidenceMetric(pair: PairData, tracker: SearchTracker): number {
  const snrConfidence =
    tracker.totalSnr !== 0 ? pair.totalSnr / tracker.totalSnr : 0;

  const activationRateConfidence =
    tracker.activationRateAvg !== 0 ? pair.activations / tracker.activationRateAvg : 0;

  let effectivenessConfidence =
    tracker.totalEffectiveness !== 0 ? pair.totalEffectiveness / tracker.totalEffectiveness : 0;

  // Boost if consecutive activations detected
  if (pair.activationsInRow > 0) {
    effectivenessConfidence *= activationRateConfidence * pair.activationsInRow;
  }

  const pairActivationRate = pair.counts > 0 ? pair.activations / pair.counts : 0;

  return Math.max(0, 0.2 * snrConfidence + 0.6 * effectivenessConfidence + 0.2 * pairActivationRate);
}

/** Update global metrics and recalculate all confidence metrics (mutates tracker in place). */
export function updateConfidenceMetrics(
  tracker: SearchTracker,
  effectiveness: number,
  avgSnr: number,
  anode: number,
  cathode: number
): void {
  tracker.totalSnr += avgSnr;
  tracker.totalEffectiveness += effectiveness;

  // Update average activation rate
  for (const pair of tracker.pairData) {
    if (pair.anode === anode && pair.cathode === cathode && pair.counts > 0) {
      tracker.activationRateAvg += pair.activations / pair.counts;
    }
  }

  // Recalculate all confidence metrics
  let totalConfidence = 0;
  for (const pair of tracker.pairData) {
    if (pair.counts > 0) {
      const cm = calculateConfidenceMetric(pair, tracker);
      pair.confidenceMetric = cm;
      totalConfidence += cm;
    }
  }

  // Normalize so they sum to 1
  if (totalConfidence > 0) {
    for (const pair of tracker.pairData) {
      pair.confidenceMetric /= totalConfidence;
    }
  }

  tracker.combinations += 1;
}

export interface PotentialBestPair {
  anode: number;
  cathode: number;
  score: number;
  confidenceMetric: number;
  activations: number;
  counts: number;
}

/** Identify pairs whose confidence exceeds 0.25. */
export function determinePotentiallyBestPairs(tracker: SearchTracker): PotentialBestPair[] {
  const bestPairs: PotentialBestPair[] = [];
  for (const pair of tracker.pairData) {
    if (pair.counts === 0) continue;
    const averageSnr = pair.totalSnr / pair.counts;
    const activationRate = pair.activations / pair.counts;
    const score = averageSnr * activationRate;

    if (pair.confidenceMetric > 0.25) {
      bestPairs.push({
        anode: pair.anode,
        cathode: pair.cathode,
        score,
        confidenceMetric: pair.confidenceMetric,
        activations: pair.activations,
        counts: pair.counts,
      });
    }
  }
  return bestPairs;
}

/**
 * Determine the definitive best pair if confidence criteria are met:
 * - confidence > 0.6 AND at least 2 activations, OR
 * - confidence ≥ 0.9 AND tested at least as many times as unique combinations.
 */
export function determineBestPair(
  potentiallyBestPairs: PotentialBestPair[],
  uniqueCombinations: number
): PotentialBestPair | null {
  for (const pair of potentiallyBestPairs) {
    if (
      (pair.confidenceMetric > 0.6 && pair.activations >= 2) ||
      (pair.confidenceMetric >= 0.9 && pair.counts >= uniqueCombinations)
    ) {
      return pair;
    }
  }
  return null;
}
