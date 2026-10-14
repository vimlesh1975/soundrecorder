/**
 * Client-side WebM to MP3 converter using Web Audio API and LAME MP3 encoder.
 * Runs 100% in the browser with zero server timeouts and no file size limits.
 */

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

/**
 * Converts a WebM audio Blob into an MP3 Blob entirely client-side.
 * @param {Blob} webmBlob - The recorded WebM blob
 * @param {Function} [onProgress] - Optional callback receiving progress percentage (0 - 100)
 * @returns {Promise<Blob>} - The converted MP3 Blob
 */
export async function convertWebmToMp3(webmBlob, onProgress) {
  const arrayBuffer = await webmBlob.arrayBuffer();

  let audioCtx;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
  } catch {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    try {
      await audioCtx.close();
    } catch {
      // Ignore audioCtx close error
    }
  }

  const numChannels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const kbps = 192; // Standard high-quality MP3 bitrate

  // Dynamic import so @breezystack/lamejs is only loaded into memory when converting
  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const mp3encoder = new Mp3Encoder(numChannels, sampleRate, kbps);

  const leftChannel = audioBuffer.getChannelData(0);
  const rightChannel = numChannels > 1 ? audioBuffer.getChannelData(1) : null;

  const leftPCM = floatTo16BitPCM(leftChannel);
  const rightPCM = rightChannel ? floatTo16BitPCM(rightChannel) : null;

  const mp3Data = [];
  const sampleBlockSize = 1152; // LAME standard block size
  const totalSamples = leftPCM.length;
  let processed = 0;

  for (let i = 0; i < totalSamples; i += sampleBlockSize) {
    const leftChunk = leftPCM.subarray(i, i + sampleBlockSize);
    const rightChunk = rightPCM ? rightPCM.subarray(i, i + sampleBlockSize) : undefined;

    const mp3buf =
      numChannels === 1
        ? mp3encoder.encodeBuffer(leftChunk)
        : mp3encoder.encodeBuffer(leftChunk, rightChunk);

    if (mp3buf && mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }

    processed += sampleBlockSize;

    // Yield to the event loop periodically every 50 blocks (~57,600 samples)
    if (i % (sampleBlockSize * 50) === 0) {
      if (onProgress) {
        onProgress(Math.min(99, Math.round((processed / totalSamples) * 100)));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const flushBuf = mp3encoder.flush();
  if (flushBuf && flushBuf.length > 0) {
    mp3Data.push(flushBuf);
  }

  if (onProgress) {
    onProgress(100);
  }

  return new Blob(mp3Data, { type: "audio/mp3" });
}
