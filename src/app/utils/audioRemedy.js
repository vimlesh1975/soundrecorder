/**
 * Offline Audio Remedy Processor with 4 independent post-processing options:
 * 1. High-Pass Filter (BiquadFilterNode at 85 Hz)
 * 2. Fast Peak Limiter (DynamicsCompressorNode + +/-12ms Lookahead Envelope Limiter)
 * 3. Spectral NR (Audacity-style 1024-bin STFT Spectral Subtraction + 7.5 kHz Hiss Filter)
 * 4. AI RNNoise (WebAssembly Neural Network Voice Isolation via @shiguredo/rnnoise-wasm)
 */

let rnnoiseInstancePromise = null;

async function getRnnoiseInstance() {
  if (!rnnoiseInstancePromise) {
    rnnoiseInstancePromise = import("@shiguredo/rnnoise-wasm").then(({ Rnnoise }) =>
      Rnnoise.load()
    );
  }
  return rnnoiseInstancePromise;
}

// In-place Radix-2 Cooley-Tukey FFT
function fftRadix2(re, im, inverse = false) {
  const n = re.length;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1.0;
      let curIm = 0.0;
      for (let k = 0; k < half; k++) {
        const evenIdx = i + k;
        const oddIdx = i + k + half;
        const tRe = curRe * re[oddIdx] - curIm * im[oddIdx];
        const tIm = curRe * im[oddIdx] + curIm * re[oddIdx];
        re[oddIdx] = re[evenIdx] - tRe;
        im[oddIdx] = im[evenIdx] - tIm;
        re[evenIdx] += tRe;
        im[evenIdx] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// #2: Audacity-style STFT Spectral Subtraction Noise Reduction
function applySpectralSubtraction(channelData) {
  const N = channelData.length;
  const fftSize = 1024;
  const hop = 512;
  const halfBins = (fftSize >> 1) + 1;

  if (N < fftSize) return;

  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / fftSize));
  }

  const numFrames = Math.floor((N - fftSize) / hop) + 1;
  const frameEnergies = new Float32Array(numFrames);

  // Pass 1: Measure frame energies to find the quietest 20% noise-profile frames
  for (let f = 0; f < numFrames; f++) {
    const offset = f * hop;
    let sumSq = 0;
    for (let i = 0; i < fftSize; i++) {
      const v = channelData[offset + i];
      sumSq += v * v;
    }
    frameEnergies[f] = sumSq / fftSize;
  }

  const sortedIndices = Array.from({ length: numFrames }, (_, idx) => idx).sort(
    (a, b) => frameEnergies[a] - frameEnergies[b]
  );
  const noiseFrameCount = Math.max(1, Math.floor(numFrames * 0.2));

  const noiseProfile = new Float32Array(halfBins);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let nIdx = 0; nIdx < noiseFrameCount; nIdx++) {
    const f = sortedIndices[nIdx];
    const offset = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = channelData[offset + i] * win[i];
      im[i] = 0;
    }
    fftRadix2(re, im, false);
    for (let k = 0; k < halfBins; k++) {
      noiseProfile[k] += Math.hypot(re[k], im[k]);
    }
  }
  for (let k = 0; k < halfBins; k++) {
    noiseProfile[k] /= noiseFrameCount;
  }

  // Pass 2: Spectral subtraction with temporal & frequency smoothing (Wiener soft gain)
  const out = new Float32Array(N);
  const norm = new Float32Array(N);
  const prevGains = new Float32Array(halfBins);
  prevGains.fill(1.0);
  const curGains = new Float32Array(halfBins);

  const overSubtraction = 1.85;
  const spectralFloor = 0.08;

  for (let f = 0; f < numFrames; f++) {
    const offset = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = channelData[offset + i] * win[i];
      im[i] = 0;
    }
    fftRadix2(re, im, false);

    for (let k = 0; k < halfBins; k++) {
      const mag = Math.hypot(re[k], im[k]) + 1e-9;
      const sub = Math.max(0, mag - overSubtraction * noiseProfile[k]);
      const rawG = Math.max(spectralFloor, sub / mag);
      // Smooth over time
      curGains[k] = 0.65 * rawG + 0.35 * prevGains[k];
      prevGains[k] = curGains[k];
    }

    // 3-bin frequency smoothing to avoid musical noise artifacts
    for (let k = 0; k < halfBins; k++) {
      const gPrev = k > 0 ? curGains[k - 1] : curGains[k];
      const gNext = k < halfBins - 1 ? curGains[k + 1] : curGains[k];
      const g = 0.25 * gPrev + 0.5 * curGains[k] + 0.25 * gNext;
      re[k] *= g;
      im[k] *= g;
      if (k > 0 && k < halfBins - 1) {
        re[fftSize - k] *= g;
        im[fftSize - k] *= g;
      }
    }

    fftRadix2(re, im, true);

    for (let i = 0; i < fftSize; i++) {
      out[offset + i] += re[i] * win[i];
      norm[offset + i] += win[i] * win[i];
    }
  }

  for (let i = 0; i < N; i++) {
    if (norm[i] > 1e-5) {
      channelData[i] = out[i] / norm[i];
    }
  }
}

// #3: AI Neural Noise Cancellation using @shiguredo/rnnoise-wasm
async function applyAiRnnoise(audioBuffer) {
  const rnnoise = await getRnnoiseInstance();
  const frameSize = rnnoise.frameSize; // 480 samples
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  for (let ch = 0; ch < numChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    const state = rnnoise.createDenoiseState();
    const frame = new Float32Array(frameSize);

    try {
      for (let i = 0; i < length; i += frameSize) {
        const count = Math.min(frameSize, length - i);
        frame.fill(0);
        // RNNoise expects 16-bit PCM range (-32768..32767)
        for (let k = 0; k < count; k++) {
          frame[k] = data[i + k] * 32768.0;
        }
        state.processFrame(frame);
        for (let k = 0; k < count; k++) {
          data[i + k] = Math.max(-1, Math.min(1, frame[k] / 32768.0));
        }
      }
    } finally {
      state.destroy();
    }
  }
}

function audioBufferToWavBlob(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(
        offset,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true
      );
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export async function createRemedyAudioUrl(
  sourceUrl,
  options = {
    highPass: false,
    peakLimiter: false,
    spectralDenoise: false,
    aiRnnoise: false,
  }
) {
  const { highPass, peakLimiter, spectralDenoise, aiRnnoise } = options;

  const response = await fetch(sourceUrl);
  const arrayBuffer = await response.arrayBuffer();

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const tempCtx = new AudioCtx();
  let decodedBuffer;
  try {
    decodedBuffer = await tempCtx.decodeAudioData(arrayBuffer);
  } finally {
    await tempCtx.close().catch(() => {});
  }

  const { numberOfChannels, length, sampleRate } = decodedBuffer;

  const offlineCtx = new OfflineAudioContext(numberOfChannels, length, sampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = decodedBuffer;

  let currentNode = source;

  // 1. High-Pass Filter (BiquadFilterNode at 85 Hz)
  if (highPass) {
    const hpFilter = offlineCtx.createBiquadFilter();
    hpFilter.type = "highpass";
    hpFilter.frequency.value = 85;
    hpFilter.Q.value = 0.707;
    currentNode.connect(hpFilter);
    currentNode = hpFilter;
  }

  // Low-pass hiss roll-off when Spectral NR is enabled
  if (spectralDenoise) {
    const lpFilter = offlineCtx.createBiquadFilter();
    lpFilter.type = "lowpass";
    lpFilter.frequency.value = 7500;
    lpFilter.Q.value = 0.707;
    currentNode.connect(lpFilter);
    currentNode = lpFilter;
  }

  // 2a. Fast Peak Limiter — Web Audio DynamicsCompressorNode (1ms attack)
  if (peakLimiter) {
    const compressor = offlineCtx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 6;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.001;
    compressor.release.value = 0.05;
    currentNode.connect(compressor);
    currentNode = compressor;
  }

  currentNode.connect(offlineCtx.destination);
  source.start(0);

  const renderedBuffer = await offlineCtx.startRendering();

  // 3. AI Neural Noise Cancellation (RNNoise WASM)
  if (aiRnnoise) {
    await applyAiRnnoise(renderedBuffer);
  }

  // 4. FFT Spectral Subtraction Noise Reduction (Audacity-style)
  if (spectralDenoise) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      applySpectralSubtraction(renderedBuffer.getChannelData(ch));
    }
  }

  // 2b. Fast Peak Limiter — Sample-Accurate +/-12ms Lookahead Plosive Spike Suppressor
  if (peakLimiter) {
    const block20ms = Math.max(1, Math.floor(sampleRate * 0.02));
    const activePeaks = [];

    for (let i = 0; i < length; i += block20ms) {
      let max = 0;
      const end = Math.min(length, i + block20ms);
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const data = renderedBuffer.getChannelData(ch);
        for (let j = i; j < end; j++) {
          const a = Math.abs(data[j]);
          if (a > max) max = a;
        }
      }
      if (max > 0.025) {
        activePeaks.push(max);
      }
    }

    activePeaks.sort((a, b) => a - b);
    const medianVoicePeak =
      activePeaks.length > 0
        ? activePeaks[Math.floor(activePeaks.length * 0.5)]
        : 0.22;
    const strictCeiling = Math.min(0.28, Math.max(0.12, medianVoicePeak * 0.9));

    const subSize = Math.max(1, Math.floor(sampleRate * 0.001));
    const numSub = Math.ceil(length / subSize);
    const subMax = new Float32Array(numSub);
    const subRmsSq = new Float32Array(numSub);

    for (let b = 0; b < numSub; b++) {
      let max = 0;
      let sumSq = 0;
      const start = b * subSize;
      const end = Math.min(length, start + subSize);
      const count = Math.max(1, (end - start) * numberOfChannels);
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const data = renderedBuffer.getChannelData(ch);
        for (let i = start; i < end; i++) {
          const v = data[i];
          const a = Math.abs(v);
          if (a > max) max = a;
          sumSq += v * v;
        }
      }
      subMax[b] = max;
      subRmsSq[b] = sumSq / count;
    }

    const rawGain = new Float32Array(numSub);
    const rmsRadius = 80;

    for (let b = 0; b < numSub; b++) {
      let rmsSum = 0;
      let rmsCnt = 0;
      const r0 = Math.max(0, b - rmsRadius);
      const r1 = Math.min(numSub - 1, b + rmsRadius);
      for (let k = r0; k <= r1; k++) {
        rmsSum += subRmsSq[k];
        rmsCnt++;
      }
      const localRms = Math.sqrt(rmsSum / Math.max(1, rmsCnt));
      const adaptiveCeiling = Math.min(strictCeiling, Math.max(0.05, localRms * 2.0));

      rawGain[b] = subMax[b] > adaptiveCeiling ? adaptiveCeiling / subMax[b] : 1.0;
    }

    const holdRadius = 12;
    const minGain = new Float32Array(numSub);
    for (let b = 0; b < numSub; b++) {
      let m = 1.0;
      const k0 = Math.max(0, b - holdRadius);
      const k1 = Math.min(numSub - 1, b + holdRadius);
      for (let k = k0; k <= k1; k++) {
        if (rawGain[k] < m) m = rawGain[k];
      }
      minGain[b] = m;
    }

    const smoothRadius = 6;
    const smoothGain = new Float32Array(numSub);
    for (let b = 0; b < numSub; b++) {
      let sum = 0;
      let cnt = 0;
      const k0 = Math.max(0, b - smoothRadius);
      const k1 = Math.min(numSub - 1, b + smoothRadius);
      for (let k = k0; k <= k1; k++) {
        sum += minGain[k];
        cnt++;
      }
      smoothGain[b] = sum / cnt;
    }

    for (let ch = 0; ch < numberOfChannels; ch++) {
      const data = renderedBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const b = Math.min(numSub - 1, Math.floor(i / subSize));
        const bNext = Math.min(numSub - 1, b + 1);
        const frac = (i - b * subSize) / subSize;
        const g = smoothGain[b] * (1 - frac) + smoothGain[bNext] * frac;
        data[i] *= g;
      }
    }
  }

  const wavBlob = audioBufferToWavBlob(renderedBuffer);
  return {
    url: URL.createObjectURL(wavBlob),
    blob: wavBlob,
  };
}
