"use client";

import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import styles from "./recorder.module.css";
import { convertWebmToMp3 } from "./utils/mp3Converter";
import { createRemedyAudioUrl } from "./utils/audioRemedy";


function getTimestamp(date = new Date()) {
  const pad = (n, z = 2) => String(n).padStart(z, "0");

  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "_" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds()) +
    pad(date.getMilliseconds(), 3)
  );
}

function formatDuration(totalSeconds = 0) {
  const pad = (n, z = 2) => String(n).padStart(z, "0");
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

const TOTAL_LED_SEGMENTS = 24;
const GREEN_LIMIT = 15;  // 0..14 (first 15 segments: Green)
const YELLOW_LIMIT = 20; // 15..19 (next 5 segments: Yellow), 20..23 (last 4: Red)

export default function Recorder() {

  const [paused, setPaused] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordings, setRecordings] = useState([]);
  const [duration, setDuration] = useState(0);
  const [micReady, setMicReady] = useState(false);
  const [deviceName, setDeviceName] = useState("Detecting microphone...");
  const [liveMicPrefs, setLiveMicPrefs] = useState({
    noiseSuppression: false,
    echoCancellation: false,
    autoGainControl: false,
  });
  const liveMicPrefsRef = useRef(liveMicPrefs);

  const analyserRef = useRef(null);
  const dataRef = useRef(null);
  const animRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);

  // VU Meter DOM refs (updated at 60fps without React re-renders)
  const ledRefs = useRef([]);
  const dbValueRef = useRef(null);
  const levelZoneRef = useRef(null);
  const smoothedLevelRef = useRef(0);
  const peakSegmentRef = useRef(-1);
  const peakHoldTimeRef = useRef(0);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  const recordingStartTimeRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const elapsedMsRef = useRef(0);
  const activeStartRef = useRef(null);
  const finalDurationRef = useRef("00:00");

  function updateLevelMeter(rms, peak) {
    // True audible amplitude (after 85Hz high-pass filter, without artificial noise-floor boost)
    const effectiveAmp = Math.min(1, Math.max(rms, peak * 0.85));

    // Convert to decibels (dBFS range: -55 dB to 0 dB)
    const MIN_DB = -55;
    const rawDb = effectiveAmp > 0.00001 ? 20 * Math.log10(effectiveAmp) : MIN_DB;
    const clampedDb = Math.max(MIN_DB, Math.min(0, rawDb));

    // Normalized 0..1 level from dB scale (noise gate below -52 dB so room silence = 0)
    const rawTarget = (clampedDb - MIN_DB) / (0 - MIN_DB);
    const targetLevel = clampedDb <= -52 ? 0 : rawTarget;

    // Fast attack, smooth release
    const prev = smoothedLevelRef.current;
    const smoothed =
      targetLevel > prev
        ? prev + (targetLevel - prev) * 0.45
        : prev + (targetLevel - prev) * 0.16;
    smoothedLevelRef.current = smoothed < 0.01 ? 0 : smoothed;

    const activeSegments = Math.round(smoothedLevelRef.current * TOTAL_LED_SEGMENTS);
    const now = performance.now();

    // Update peak hold segment
    const currentTopIdx = activeSegments - 1;
    if (currentTopIdx >= peakSegmentRef.current) {
      peakSegmentRef.current = currentTopIdx;
      peakHoldTimeRef.current = now;
    } else if (now - peakHoldTimeRef.current > 700 && peakSegmentRef.current >= 0) {
      peakSegmentRef.current = Math.max(currentTopIdx, peakSegmentRef.current - 0.25);
    }
    const peakIdx = Math.round(peakSegmentRef.current);

    // Update LED segment DOM nodes directly
    for (let i = 0; i < TOTAL_LED_SEGMENTS; i++) {
      const el = ledRefs.current[i];
      if (!el) continue;
      const isLit = i < activeSegments;
      const isPeakHold = !isLit && i === peakIdx && peakIdx > 0;
      el.dataset.active = isLit ? "true" : isPeakHold ? "peak" : "false";
    }

    // Update dB readout and zone status badge
    if (dbValueRef.current) {
      dbValueRef.current.textContent =
        activeSegments === 0 || clampedDb <= -52
          ? "-∞ dB"
          : `${Math.round(clampedDb)} dB`;
    }

    if (levelZoneRef.current) {
      if (activeSegments === 0) {
        levelZoneRef.current.textContent = "SILENT";
        levelZoneRef.current.dataset.zone = "idle";
      } else if (activeSegments > YELLOW_LIMIT) {
        levelZoneRef.current.textContent = "PEAK / HIGH";
        levelZoneRef.current.dataset.zone = "red";
      } else if (activeSegments > GREEN_LIMIT) {
        levelZoneRef.current.textContent = "CAUTION";
        levelZoneRef.current.dataset.zone = "yellow";
      } else {
        levelZoneRef.current.textContent = "GOOD";
        levelZoneRef.current.dataset.zone = "green";
      }
    }
  }

  function startLevelLoop() {
    if (!analyserRef.current) return;

    const tick = () => {
      if (!analyserRef.current || !dataRef.current) return;
      analyserRef.current.getFloatTimeDomainData(dataRef.current);

      let sum = 0;
      let peak = 0;
      for (let i = 0; i < dataRef.current.length; i++) {
        const v = dataRef.current[i];
        sum += v * v;
        const absV = Math.abs(v);
        if (absV > peak) peak = absV;
      }
      const rms = Math.sqrt(sum / dataRef.current.length);

      updateLevelMeter(rms, peak);

      animRef.current = requestAnimationFrame(tick);
    };

    tick();
  }

  function cleanDeviceLabel(label = "") {
    return (
      label
        // Remove parenthesized USB VID:PID or hex IDs like (4c4a:4155) or (4c4a)
        .replace(/\s*\([0-9a-fA-F]{4}(?::[0-9a-fA-F]{4})?\)/g, "")
        // Remove standalone VID:PID pairs like 4c4a:4155
        .replace(/\b[0-9a-fA-F]{4}:[0-9a-fA-F]{4}\b/g, "")
        // Remove standalone 4-to-8 char mixed hex technical tokens like 4c4a
        .replace(/\b(?=.*[0-9])(?=.*[a-fA-F])[0-9a-fA-F]{4,8}\b/g, "")
        // Clean up any empty parentheses or leftover dashes/spaces inside parentheses
        .replace(/\(\s*[-–—,:]?\s*\)/g, "")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .replace(/\s{2,}/g, " ")
        .trim() || "Default Microphone"
    );
  }

  async function updateActiveDeviceLabel(stream) {
    const track = stream?.getAudioTracks?.()[0];
    if (track?.label) {
      setDeviceName(cleanDeviceLabel(track.label));
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const defaultMic =
        devices.find((d) => d.kind === "audioinput" && d.deviceId === "default") ||
        devices.find((d) => d.kind === "audioinput" && d.label);
      setDeviceName(cleanDeviceLabel(defaultMic?.label || "Default Microphone"));
    } catch {
      setDeviceName("Default Microphone");
    }
  }

  async function ensureMicMonitoring(forceRefresh = false, customPrefs = null) {
    const prefs = customPrefs || liveMicPrefsRef.current;

    if (
      !forceRefresh &&
      streamRef.current &&
      streamRef.current.active &&
      analyserRef.current
    ) {
      if (audioCtxRef.current?.state === "suspended") {
        await audioCtxRef.current.resume().catch(() => {});
      }
      if (!animRef.current) {
        startLevelLoop();
      }
      await updateActiveDeviceLabel(streamRef.current);
      setMicReady(true);
      return streamRef.current;
    }

    if (forceRefresh && streamRef.current) {
      if (animRef.current) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
      streamRef.current.getTracks().forEach((t) => t.stop());
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { ideal: "default" },
          echoCancellation: prefs.echoCancellation,
          noiseSuppression: prefs.noiseSuppression,
          autoGainControl: prefs.autoGainControl,
        },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    streamRef.current = stream;
    await updateActiveDeviceLabel(stream);

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    audioCtxRef.current = audioCtx;

    const source = audioCtx.createMediaStreamSource(stream);
    const meterHighPass = audioCtx.createBiquadFilter();
    meterHighPass.type = "highpass";
    meterHighPass.frequency.value = 85;
    meterHighPass.Q.value = 0.707;

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    source.connect(meterHighPass);
    meterHighPass.connect(analyser);

    analyserRef.current = analyser;
    dataRef.current = new Float32Array(analyser.fftSize);

    setMicReady(true);
    startLevelLoop();
    return stream;
  }

  function handleToggleLiveMicPref(key, checked) {
    const next = { ...liveMicPrefsRef.current, [key]: checked };
    liveMicPrefsRef.current = next;
    setLiveMicPrefs(next);
    if (!recording) {
      ensureMicMonitoring(true, next).catch(() => {});
    }
  }

  useEffect(() => {
    ensureMicMonitoring().catch((err) => {
      console.warn("Pre-recording mic monitor waiting for permission/gesture:", err);
      setDeviceName("Click to allow microphone access");
    });

    const handleUserGesture = () => {
      if (audioCtxRef.current?.state === "suspended") {
        audioCtxRef.current.resume().catch(() => {});
      }
    };

    const handleDeviceChange = () => {
      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
        ensureMicMonitoring(true).catch(() => {});
      }
    };

    window.addEventListener("pointerdown", handleUserGesture);
    window.addEventListener("keydown", handleUserGesture);
    navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);

    return () => {
      window.removeEventListener("pointerdown", handleUserGesture);
      window.removeEventListener("keydown", handleUserGesture);
      navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (animRef.current) cancelAnimationFrame(animRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startRecording() {
    const stream = await ensureMicMonitoring();

    /* MediaRecorder */
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: "audio/webm",
    });

    mediaRecorderRef.current = mediaRecorder;
    chunksRef.current = [];

    mediaRecorder.ondataavailable = (e) => chunksRef.current.push(e.data);

    mediaRecorder.onstop = () => {
      const startTime = recordingStartTimeRef.current; // 👈 START TIME
      const fileDuration = finalDurationRef.current || formatDuration(0);

      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      setRecordings((prev) => [
        {
          id: crypto.randomUUID(),
          url,
          displayTime: startTime.toLocaleTimeString(),
          timestamp: getTimestamp(startTime), // 👈 START timestamp
          duration: fileDuration,
        },
        ...prev,
      ]);

    };
    recordingStartTimeRef.current = new Date();
    setPaused(false);

    // Reset and start recording duration timer
    elapsedMsRef.current = 0;
    activeStartRef.current = new Date().getTime();
    setDuration(0);

    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = setInterval(() => {
      if (activeStartRef.current) {
        const currentSegment = new Date().getTime() - activeStartRef.current;
        setDuration(Math.floor((elapsedMsRef.current + currentSegment) / 1000));
      }
    }, 200);

    mediaRecorder.start();

    if (!animRef.current) {
      startLevelLoop();
    }
    setRecording(true);
  }

  function stopRecording() {
    let totalMs = elapsedMsRef.current;
    if (activeStartRef.current) {
      totalMs += new Date().getTime() - activeStartRef.current;
    }
    const finalSeconds = Math.max(0, Math.floor(totalMs / 1000));
    finalDurationRef.current = formatDuration(finalSeconds);

    mediaRecorderRef.current?.stop();

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    activeStartRef.current = null;
    elapsedMsRef.current = 0;

    setRecording(false);
    setPaused(false);
    setDuration(0);

    // Keep VU meter running in pre-recording mode
    if (!animRef.current && analyserRef.current) {
      startLevelLoop();
    }
  }

  function pauseRecording() {
    if (!mediaRecorderRef.current) return;

    mediaRecorderRef.current.pause();
    if (animRef.current) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (activeStartRef.current) {
      elapsedMsRef.current += new Date().getTime() - activeStartRef.current;
      activeStartRef.current = null;
    }
    setDuration(Math.floor(elapsedMsRef.current / 1000));
    setPaused(true);
  }

  function resumeRecording() {
    if (!mediaRecorderRef.current) return;

    mediaRecorderRef.current.resume();
    if (!animRef.current) {
      startLevelLoop();
    }

    activeStartRef.current = new Date().getTime();
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = setInterval(() => {
      if (activeStartRef.current) {
        const currentSegment = new Date().getTime() - activeStartRef.current;
        setDuration(Math.floor((elapsedMsRef.current + currentSegment) / 1000));
      }
    }, 200);

    setPaused(false);
  }
  function deleteRecording(id) {
    setRecordings((prev) => {
      const rec = prev.find((r) => r.id === id);
      if (rec?.url) {
        URL.revokeObjectURL(rec.url); // ✅ prevent memory leak
      }
      return prev.filter((r) => r.id !== id);
    });
  }

  return (
    <div className={styles.page}>
      {/* FIXED TOP */}
      <div className={styles.fixedTop}>
        <div className={styles.headerRow}>
          <h2 className={styles.heading}>🎙 Audio Recorder</h2>
          {recording && (
            <div
              className={`${styles.timerBadge} ${
                paused ? styles.timerPaused : styles.timerRecording
              }`}
              aria-live="polite"
              aria-label={
                paused
                  ? `Recording paused at ${formatDuration(duration)}`
                  : `Recording duration: ${formatDuration(duration)}`
              }
            >
              <span className={styles.timerDot} />
              <span className={styles.timerDigits}>{formatDuration(duration)}</span>
              {paused && <span className={styles.pausedTag}>PAUSED</span>}
            </div>
          )}
        </div>

        <button
          onClick={recording ? stopRecording : startRecording}
          className={`${styles.primaryBtn} ${recording ? styles.stop : styles.start
            }`}
        >
          {recording ? "Stop Recording" : "Start Recording"}
        </button>

        {recording && (
          <button
            onClick={paused ? resumeRecording : pauseRecording}
            className={styles.smallBtn}
            style={{ marginTop: 10 }}
          >
            {paused ? "▶ Resume" : "⏸ Pause"}
          </button>
        )}

        {/* HORIZONTAL LED SEGMENTED SOUND LEVEL METER (PRE-RECORDING & RECORDING) */}
        <div
          className={styles.vuMeterContainer}
          onClick={() => {
            if (!micReady) ensureMicMonitoring().catch(() => {});
          }}
          title={!micReady ? "Click to enable microphone level check" : `Active microphone: ${deviceName}`}
        >
          <div className={styles.deviceRow}>
            <span className={styles.deviceIcon}>🎤</span>
            <span className={styles.deviceNameText} title={deviceName}>
              {deviceName}
            </span>
          </div>

          <div className={styles.vuHeader}>
            <span className={styles.vuLabel}>
              <span
                className={`${styles.micStatusDot} ${
                  micReady && !paused ? styles.micStatusActive : ""
                }`}
              />
              {recording ? (paused ? "MIC PAUSED" : "LIVE LEVEL") : "MIC CHECK"}
            </span>
            <div className={styles.vuReadout}>
              <span
                ref={levelZoneRef}
                className={styles.vuZoneBadge}
                data-zone="idle"
              >
                {micReady ? "SILENT" : "CLICK FOR MIC"}
              </span>
              <span ref={dbValueRef} className={styles.vuDbText}>
                -∞ dB
              </span>
            </div>
          </div>

          <div
            className={styles.vuBar}
            aria-label="Microphone sound level"
          >
            {Array.from({ length: TOTAL_LED_SEGMENTS }).map((_, i) => {
              const colorZone =
                i < GREEN_LIMIT
                  ? "green"
                  : i < YELLOW_LIMIT
                  ? "yellow"
                  : "red";
              return (
                <div
                  key={i}
                  ref={(el) => (ledRefs.current[i] = el)}
                  className={styles.vuSegment}
                  data-color={colorZone}
                  data-active="false"
                />
              );
            })}
          </div>

          <div className={styles.vuScale}>
            <span className={styles.scaleGreen}>🟢 Safe (-55 to -15 dB)</span>
            <span className={styles.scaleYellow}>🟡 Caution (-15 to -5 dB)</span>
            <span className={styles.scaleRed}>🔴 Peak (0 dB)</span>
          </div>

          {/* #1: LIVE BROWSER WEBRTC MIC CANCELLATION TOGGLES */}
          <div
            className={styles.liveMicFiltersRow}
            onClick={(e) => e.stopPropagation()}
          >
            <span className={styles.liveMicFiltersTitle}>Live Mic:</span>
            <label
              className={`${styles.liveFilterPill} ${
                liveMicPrefs.noiseSuppression ? styles.liveFilterActive : ""
              }`}
              title="Browser WebRTC Live Noise Suppression (getUserMedia)"
            >
              <input
                type="checkbox"
                checked={liveMicPrefs.noiseSuppression}
                disabled={recording}
                onChange={(e) =>
                  handleToggleLiveMicPref("noiseSuppression", e.target.checked)
                }
                className={styles.remedyCheckbox}
              />
              <span>Noise Cancel</span>
            </label>

            <label
              className={`${styles.liveFilterPill} ${
                liveMicPrefs.echoCancellation ? styles.liveFilterActive : ""
              }`}
              title="Browser WebRTC Live Echo Cancellation (getUserMedia)"
            >
              <input
                type="checkbox"
                checked={liveMicPrefs.echoCancellation}
                disabled={recording}
                onChange={(e) =>
                  handleToggleLiveMicPref("echoCancellation", e.target.checked)
                }
                className={styles.remedyCheckbox}
              />
              <span>Echo Cancel</span>
            </label>

            <label
              className={`${styles.liveFilterPill} ${
                liveMicPrefs.autoGainControl ? styles.liveFilterActive : ""
              }`}
              title="Browser WebRTC Live Auto Gain Control (getUserMedia)"
            >
              <input
                type="checkbox"
                checked={liveMicPrefs.autoGainControl}
                disabled={recording}
                onChange={(e) =>
                  handleToggleLiveMicPref("autoGainControl", e.target.checked)
                }
                className={styles.remedyCheckbox}
              />
              <span>Auto Gain</span>
            </label>
          </div>
        </div>
      </div>

      {/* SCROLLABLE RECORDINGS */}
      <div className={styles.scrollArea}>
        <h3>📂 Recordings</h3>

        {recordings.length === 0 && (
          <div className={styles.empty}>No recordings yet</div>
        )}

        {recordings.map((rec, index) => (
          <RecordingItem
            key={rec.id}
            rec={rec}
            index={index}
            total={recordings.length}
            onDelete={deleteRecording}
          />
        ))}
      </div>
    </div>
  );
}

/* ---------------- Recording Item ---------------- */

function RecordingItem({ rec, index, total, onDelete }) {

  const [isConverting, setIsConverting] = useState(false);
  const [convertProgress, setConvertProgress] = useState(null);
  const [audioDuration, setAudioDuration] = useState(rec.duration || "00:00");

  // 4 Separate Post-Recording Audio Remedy Checkboxes
  const [remedyOptions, setRemedyOptions] = useState({
    highPass: false,
    peakLimiter: false,
    spectralDenoise: false,
    aiRnnoise: false,
  });
  const [processedUrl, setProcessedUrl] = useState(null);
  const [isProcessingRemedy, setIsProcessingRemedy] = useState(false);

  const waveRef = useRef(null);
  const waveSurferRef = useRef(null);
  const remedyCacheRef = useRef(new Map());

  const recordingNumber = total - index;
  const anyRemedyActive =
    remedyOptions.highPass ||
    remedyOptions.peakLimiter ||
    remedyOptions.spectralDenoise ||
    remedyOptions.aiRnnoise;
  const activeUrl = anyRemedyActive && processedUrl ? processedUrl : rec.url;

  useEffect(() => {
    const cache = remedyCacheRef.current;
    return () => {
      cache.forEach((url) => URL.revokeObjectURL(url));
      cache.clear();
    };
  }, []);

  useEffect(() => {
    if (!waveRef.current) return;
    waveRef.current.innerHTML = "";

    const ws = WaveSurfer.create({
      container: waveRef.current,
      height: 80,
      waveColor: anyRemedyActive ? "#a5d6a7" : "#ccc",
      progressColor: anyRemedyActive ? "#2e7d32" : "#1e88e5",
      normalize: true,     // 👈 important
    });

    waveSurferRef.current = ws;

    ws.on("error", (err) => {
      if (err?.name === "AbortError" || err?.message?.includes("aborted")) return;
      console.error("WaveSurfer error:", err);
    });

    ws.on("ready", () => {
      const d = ws.getDuration();
      if (d && !isNaN(d) && isFinite(d) && d > 0) {
        setAudioDuration(formatDuration(Math.round(d)));
      }
    });

    ws.load(activeUrl).catch((err) => {
      if (err?.name === "AbortError" || err?.message?.includes("aborted")) return;
      console.error("WaveSurfer load error:", err);
    });

    return () => {
      try {
        ws.destroy();
      } catch (err) {
        if (err?.name !== "AbortError" && !err?.message?.includes("aborted")) {
          console.error("WaveSurfer destroy error:", err);
        }
      }
      waveSurferRef.current = null;
    };
  }, [activeUrl, anyRemedyActive]);

  async function handleOptionChange(key, checked) {
    const nextOptions = { ...remedyOptions, [key]: checked };
    setRemedyOptions(nextOptions);

    const isAnyChecked =
      nextOptions.highPass ||
      nextOptions.peakLimiter ||
      nextOptions.spectralDenoise ||
      nextOptions.aiRnnoise;

    if (!isAnyChecked) {
      setProcessedUrl(null);
      return;
    }

    const cacheKey = `${nextOptions.highPass}-${nextOptions.peakLimiter}-${nextOptions.spectralDenoise}-${nextOptions.aiRnnoise}`;
    if (remedyCacheRef.current.has(cacheKey)) {
      setProcessedUrl(remedyCacheRef.current.get(cacheKey));
      return;
    }

    setIsProcessingRemedy(true);
    try {
      const result = await createRemedyAudioUrl(rec.url, nextOptions);
      remedyCacheRef.current.set(cacheKey, result.url);
      setProcessedUrl(result.url);
    } catch (err) {
      console.error("Audio remedy processing failed:", err);
      alert("Failed to apply audio remedy: " + (err?.message || "Unknown error"));
    } finally {
      setIsProcessingRemedy(false);
    }
  }

  function getRemedySuffix() {
    if (!anyRemedyActive || !processedUrl) return "";
    const parts = [];
    if (remedyOptions.highPass) parts.push("hp");
    if (remedyOptions.peakLimiter) parts.push("lim");
    if (remedyOptions.spectralDenoise) parts.push("spec");
    if (remedyOptions.aiRnnoise) parts.push("ai");
    return `_remedy-${parts.join("-")}`;
  }

  function saveRecording() {
    const a = document.createElement("a");
    a.href = activeUrl;
    const ext = anyRemedyActive && processedUrl ? "wav" : "webm";
    const suffix = getRemedySuffix();
    a.download = `recording-${recordingNumber}_${rec.timestamp}${suffix}.${ext}`;
    a.click();
  }

  async function downloadMp3() {
    if (isConverting) return;

    setIsConverting(true);
    setConvertProgress(0);
    const recordingNumber = total - index;
    const suffix = getRemedySuffix();

    try {
      const response = await fetch(activeUrl);
      const sourceBlob = await response.blob();

      let mp3Blob;
      try {
        // 1. Client-side conversion (no server timeout, no upload limit, runs 100% in browser)
        mp3Blob = await convertWebmToMp3(sourceBlob, (percent) => {
          setConvertProgress(percent);
        });
      } catch (clientErr) {
        console.warn("Client-side MP3 conversion failed, falling back to server route:", clientErr);
        // 2. Graceful fallback to server API route
        const formData = new FormData();
        formData.append("file", sourceBlob, "recording.webm");

        const mp3Response = await fetch("/api/convert-mp3", {
          method: "POST",
          body: formData,
        });

        if (!mp3Response.ok) throw clientErr;
        mp3Blob = await mp3Response.blob();
      }

      const a = document.createElement("a");
      const downloadUrl = URL.createObjectURL(mp3Blob);
      a.href = downloadUrl;
      a.download = `recording-${recordingNumber}_${rec.timestamp}${suffix}.mp3`;
      a.click();
      URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      console.error("MP3 conversion failed:", err);
      alert("MP3 conversion failed: " + (err?.message || "Unknown error"));
    } finally {
      setIsConverting(false);
      setConvertProgress(null);
    }
  }


  return (
    <div className={styles.recordingItem}>
      <div className={styles.recordingHeader}>
        <div className={styles.recordingTitle}>
          Recording {recordingNumber}---{rec.displayTime}-{rec.timestamp}
        </div>
        <div className={styles.recordingDuration}>
          {audioDuration || rec.duration || "00:00"}
        </div>
      </div>

      {/* SEPARATE POST-RECORDING REMEDY CHECKBOXES */}
      <div className={styles.remedyOptionsGroup}>
        <label
          className={`${styles.remedyOptionPill} ${
            remedyOptions.highPass ? styles.remedyOptionActive : ""
          }`}
          title="BiquadFilterNode at 85 Hz: Removes 11-12 Hz USB sub-bass rumble and low P/Bh/F pop energy"
        >
          <input
            type="checkbox"
            checked={remedyOptions.highPass}
            disabled={isProcessingRemedy}
            onChange={(e) => handleOptionChange("highPass", e.target.checked)}
            className={styles.remedyCheckbox}
          />
          <span>High-Pass</span>
        </label>

        <label
          className={`${styles.remedyOptionPill} ${
            remedyOptions.peakLimiter ? styles.remedyOptionActive : ""
          }`}
          title="DynamicsCompressorNode (1ms attack) + Lookahead Limiter: Stops 1-3ms consonant spikes from jumping 3x higher"
        >
          <input
            type="checkbox"
            checked={remedyOptions.peakLimiter}
            disabled={isProcessingRemedy}
            onChange={(e) => handleOptionChange("peakLimiter", e.target.checked)}
            className={styles.remedyCheckbox}
          />
          <span>Peak Limiter</span>
        </label>

        <label
          className={`${styles.remedyOptionPill} ${
            remedyOptions.spectralDenoise ? styles.remedyOptionActive : ""
          }`}
          title="#2 Spectral Noise Reduction (Audacity-style FFT Spectral Subtraction + 7.5 kHz Hiss Filter)"
        >
          <input
            type="checkbox"
            checked={remedyOptions.spectralDenoise}
            disabled={isProcessingRemedy}
            onChange={(e) =>
              handleOptionChange("spectralDenoise", e.target.checked)
            }
            className={styles.remedyCheckbox}
          />
          <span>Spectral NR</span>
        </label>

        <label
          className={`${styles.remedyOptionPill} ${
            remedyOptions.aiRnnoise ? styles.remedyOptionActive : ""
          }`}
          title="#3 AI Neural Voice Isolation (RNNoise WebAssembly like OBS / Discord)"
        >
          <input
            type="checkbox"
            checked={remedyOptions.aiRnnoise}
            disabled={isProcessingRemedy}
            onChange={(e) => handleOptionChange("aiRnnoise", e.target.checked)}
            className={styles.remedyCheckbox}
          />
          <span>AI RNNoise</span>
        </label>

        {isProcessingRemedy && (
          <span className={styles.remedyProcessingTag}>⏳</span>
        )}
      </div>

      <div ref={waveRef} />

      <div className={styles.controls}>
        <button
          className={styles.smallBtn}
          onClick={() => waveSurferRef.current?.playPause()}
        >
          ▶ Play / Pause
        </button>
        <button
          className={styles.smallBtn}
          onClick={saveRecording}
        >
          💾 {anyRemedyActive && processedUrl ? "Save WAV" : "Save webm"}
        </button>
        <button
          className={styles.smallBtn}
          onClick={downloadMp3}
          disabled={isConverting}
          style={{
            opacity: isConverting ? 0.6 : 1,
            cursor: isConverting ? "not-allowed" : "pointer",
          }}
        >
          {isConverting
            ? convertProgress !== null
              ? `⏳ Converting ${convertProgress}%…`
              : "⏳ Converting…"
            : "💾 Save MP3"}
        </button>
        <button
          className={styles.smallBtn}
          onClick={() => onDelete(rec.id)}
          style={{ background: "#f44336", color: "#fff" }}
        >
          🗑 Delete
        </button>

      </div>
    </div>
  );
}
