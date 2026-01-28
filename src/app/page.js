"use client";

import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import styles from "./recorder.module.css";

export default function Recorder() {
  const canvasRef = useRef(null);
  const analyserRef = useRef(null);
  const dataRef = useRef(null);
  const animRef = useRef(null);

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  const [recording, setRecording] = useState(false);
  const [recordings, setRecordings] = useState([]);

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
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);

      setRecordings((prev) => [
        {
          id: crypto.randomUUID(),
          url,
          time: new Date().toLocaleTimeString(),
        },
        ...prev,
      ]);

    };

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
    mediaRecorderRef.current?.stop();
    cancelAnimationFrame(animRef.current);
    setRecording(false);
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

      for (let i = 0; i < dataRef.current.length; i++) {
        const v = dataRef.current[i] / 128;
        const y = (v * canvas.height) / 2;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        x += slice;
      }

      ctx.lineWidth = 2;
      ctx.strokeStyle = "#1e88e5";
      ctx.stroke();

      animRef.current = requestAnimationFrame(draw);
    };

    draw();
  }

  return (
    <div className={styles.page}>
      {/* FIXED TOP */}
      <div className={styles.fixedTop}>
        <h2>🎙 Audio Recorder</h2>

        <button
          onClick={recording ? stopRecording : startRecording}
          className={`${styles.primaryBtn} ${recording ? styles.stop : styles.start
            }`}
        >
          {recording ? "Stop Recording" : "Start Recording"}
        </button>

        <canvas
          ref={canvasRef}
          width={460}
          height={80}
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
          <RecordingItem key={rec.id} rec={rec} index={index} total={recordings.length} />
        ))}
      </div>
    </div>
  );
}

/* ---------------- Recording Item ---------------- */

function RecordingItem({ rec, index, total }) {

  const [isConverting, setIsConverting] = useState(false);

  const waveRef = useRef(null);
  const waveSurferRef = useRef(null);

  const recordingNumber = total - index;

  useEffect(() => {
    waveRef.current.innerHTML = "";

    const ws = WaveSurfer.create({
      container: waveRef.current,
      height: 60,
      waveColor: "#ccc",
      progressColor: "#1e88e5",
    });

    waveSurferRef.current = ws;
    ws.load(rec.url);

    return () => {
      waveSurferRef.current = null;
    };
  }, [rec.url]);

  function saveRecording() {
    const a = document.createElement("a");
    a.href = rec.url;
    a.download = `recording-${recordingNumber}.webm`;
    a.click();
  }

  async function downloadMp3() {

    if (isConverting) return;

    setIsConverting(true);
    const recordingNumber = total - index;

    try {
      const response = await fetch(rec.url);
      const webmBlob = await response.blob();

      const formData = new FormData();
      formData.append("file", webmBlob, "recording.webm");

      const mp3Response = await fetch("/api/convert-mp3", {
        method: "POST",
        body: formData,
      });

      if (!mp3Response.ok) throw new Error();

      const mp3Blob = await mp3Response.blob();

      const a = document.createElement("a");
      a.href = URL.createObjectURL(mp3Blob);
      a.download = `recording-${recordingNumber}.mp3`;
      a.click();
    } catch {
      alert("MP3 conversion failed");
    } finally {
      setIsConverting(false);
    }
  }


  return (
    <div className={styles.recordingItem}>
      <div className={styles.recordingTitle}>
        Recording {recordingNumber} — {rec.time}
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
          {isConverting ? "⏳ Converting…" : "💾 Save MP3"}
        </button>
      </div>
    </div>
  );
}
