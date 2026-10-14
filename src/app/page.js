"use client";

import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import styles from "./recorder.module.css";
import { convertWebmToMp3 } from "./utils/mp3Converter";


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

export default function Recorder() {

  const [paused, setPaused] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordings, setRecordings] = useState([]);
  const [duration, setDuration] = useState(0);

  const canvasRef = useRef(null);
  const analyserRef = useRef(null);
  const dataRef = useRef(null);
  const animRef = useRef(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  const recordingStartTimeRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const elapsedMsRef = useRef(0);
  const activeStartRef = useRef(null);
  const finalDurationRef = useRef("00:00");

  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, []);

  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: "default" },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

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
      const now = new Date(); // 👈 FIX: define it
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

    /* Live waveform */
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();

    analyser.fftSize = 2048;
    source.connect(analyser);

    analyserRef.current = analyser;
    dataRef.current = new Uint8Array(analyser.fftSize);

    drawWave();
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
    cancelAnimationFrame(animRef.current);

    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    activeStartRef.current = null;
    elapsedMsRef.current = 0;

    setRecording(false);
    setPaused(false);
    setDuration(0);
  }

  function pauseRecording() {
    if (!mediaRecorderRef.current) return;

    mediaRecorderRef.current.pause();
    cancelAnimationFrame(animRef.current); // pause live waveform

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
    drawWave(); // resume live waveform

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


  function drawWave() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    const draw = () => {
      analyserRef.current.getByteTimeDomainData(dataRef.current);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.beginPath();

      const slice = canvas.width / dataRef.current.length;
      let x = 0;

      // ---- AUTO GAIN CALCULATION ----
      let sum = 0;
      for (let i = 0; i < dataRef.current.length; i++) {
        const v = (dataRef.current[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataRef.current.length);

      // Prevent crazy scaling
      const AUTO_GAIN = Math.min(4, Math.max(1.5, 0.3 / (rms || 0.0001)));

      for (let i = 0; i < dataRef.current.length; i++) {
        const v = (dataRef.current[i] - 128) / 128;

        const y =
          canvas.height / 2 +
          v * (canvas.height / 2) * AUTO_GAIN;

        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        x += slice;
      }



      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#1e88e5";
      ctx.stroke();

      animRef.current = requestAnimationFrame(draw);
    };

    draw();
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

        <canvas
          ref={canvasRef}
          width={460}
          height={40}
          className={styles.liveCanvas}
        />
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

  const waveRef = useRef(null);
  const waveSurferRef = useRef(null);

  const recordingNumber = total - index;

  useEffect(() => {
    if (!waveRef.current) return;
    waveRef.current.innerHTML = "";

    const ws = WaveSurfer.create({
      container: waveRef.current,
      height: 80,
      waveColor: "#ccc",
      progressColor: "#1e88e5",
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

    ws.load(rec.url).catch((err) => {
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
  }, [rec.url]);

  function saveRecording() {
    const a = document.createElement("a");
    a.href = rec.url;
    // a.download = `recording-${recordingNumber}.webm`;
    // a.download = `recording-${recordingNumber}_${getTimestamp()}.webm`;
    a.download = `recording-${recordingNumber}_${rec.timestamp}.webm`;


    a.click();
  }

  async function downloadMp3() {
    if (isConverting) return;

    setIsConverting(true);
    setConvertProgress(0);
    const recordingNumber = total - index;

    try {
      const response = await fetch(rec.url);
      const webmBlob = await response.blob();

      let mp3Blob;
      try {
        // 1. Client-side conversion (no server timeout, no upload limit, runs 100% in browser)
        mp3Blob = await convertWebmToMp3(webmBlob, (percent) => {
          setConvertProgress(percent);
        });
      } catch (clientErr) {
        console.warn("Client-side MP3 conversion failed, falling back to server route:", clientErr);
        // 2. Graceful fallback to server API route
        const formData = new FormData();
        formData.append("file", webmBlob, "recording.webm");

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
      a.download = `recording-${recordingNumber}_${rec.timestamp}.mp3`;
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
          💾 Save webm
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
