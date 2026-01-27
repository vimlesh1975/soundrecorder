"use client";

import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

export default function Recorder() {
  const canvasRef = useRef(null);
  const liveAnalyserRef = useRef(null);
  const liveDataRef = useRef(null);
  const liveAnimRef = useRef(null);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const [recording, setRecording] = useState(false);
  const [recordings, setRecordings] = useState([]);

  async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: "default" },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // MediaRecorder
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: "audio/webm",
    });
    mediaRecorderRef.current = mediaRecorder;
    audioChunksRef.current = [];

    mediaRecorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);

    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);

      setRecordings((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          url,
          time: new Date().toLocaleTimeString(),
        },
      ]);
    };

    mediaRecorder.start();

    // Live waveform
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();

    analyser.fftSize = 2048;
    source.connect(analyser);

    liveAnalyserRef.current = analyser;
    liveDataRef.current = new Uint8Array(analyser.fftSize);

    drawLiveWave();
    setRecording(true);
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    cancelAnimationFrame(liveAnimRef.current);
    setRecording(false);
  }

  function drawLiveWave() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    const draw = () => {
      liveAnalyserRef.current.getByteTimeDomainData(liveDataRef.current);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.beginPath();

      const slice = canvas.width / liveDataRef.current.length;
      let x = 0;

      for (let i = 0; i < liveDataRef.current.length; i++) {
        const v = liveDataRef.current[i] / 128;
        const y = (v * canvas.height) / 2;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        x += slice;
      }

      ctx.strokeStyle = "#1e88e5";
      ctx.lineWidth = 2;
      ctx.stroke();

      liveAnimRef.current = requestAnimationFrame(draw);
    };

    draw();
  }

  return (
    <div style={{ maxWidth: 500, margin: "auto", padding: 20 }}>
      <h2>🎙 Audio Recorder</h2>

      <button
        onClick={recording ? stopRecording : startRecording}
        style={{
          width: "100%",
          padding: 14,
          fontSize: 18,
          background: recording ? "#e53935" : "#1e88e5",
          color: "#fff",
          border: "none",
          borderRadius: 10,
        }}
      >
        {recording ? "Stop Recording" : "Start Recording"}
      </button>

      <canvas
        ref={canvasRef}
        width={460}
        height={80}
        style={{ marginTop: 20, width: "100%" }}
      />

      {/* 🔽 RECORDING LIST */}
      <h3 style={{ marginTop: 30 }}>📂 Recordings</h3>

      {recordings.map((rec, index) => (
        <RecordingItem key={rec.id} rec={rec} index={index} />
      ))}
    </div>
  );
}

// 🎧 Individual recording component
function RecordingItem({ rec, index }) {
  const waveRef = useRef(null);
  const waveSurferRef = useRef(null);
  const readyRef = useRef(false);

 useEffect(() => {
  // ✅ Clear previous DOM (StrictMode fix)
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
    try {
      ws.destroy();
    } catch {}
  };
}, [rec.url]);


  function saveRecording() {
    const a = document.createElement("a");
    a.href = rec.url;
    a.download = `recording-${index + 1}-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: 10,
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 14, marginBottom: 6 }}>
        Recording {index + 1} — {rec.time}
      </div>

      <div ref={waveRef} />

      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button onClick={() => waveSurferRef.current?.playPause()}>
          ▶ Play / Pause
        </button>

        <button onClick={saveRecording}>
          💾 Save
        </button>
      </div>
    </div>
  );
}
