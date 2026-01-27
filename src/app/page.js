"use client";

import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";

export default function Recorder() {
  const waveformRef = useRef(null);
  const waveSurferRef = useRef(null);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const volumeRef = useRef(null);

  const [recording, setRecording] = useState(false);
  const [audioURL, setAudioURL] = useState(null);

  // Init WaveSurfer
  useEffect(() => {
    waveSurferRef.current = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: "#90caf9",
      progressColor: "#1e88e5",
      height: 80,
      responsive: true,
    });

    return () => waveSurferRef.current?.destroy();
  }, []);

  async function startRecording() {
   const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: "default" },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
  });

  const track = stream.getAudioTracks()[0];
  console.log("🎙 Mic in use:", track.label);


    // 🎧 MediaRecorder
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: "audio/webm",
    });
    mediaRecorderRef.current = mediaRecorder;
    audioChunksRef.current = [];

    mediaRecorder.ondataavailable = (e) => audioChunksRef.current.push(e.data);

    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      setAudioURL(url);
      waveSurferRef.current.load(url);
    };

    mediaRecorder.start();

    // 🔊 Volume Meter
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();

    analyser.fftSize = 256;
    source.connect(analyser);

    audioContextRef.current = audioContext;
    analyserRef.current = analyser;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const updateVolume = () => {
      analyser.getByteFrequencyData(dataArray);
      const avg =
        dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

      volumeRef.current.style.width = `${avg}%`;

      if (recording) requestAnimationFrame(updateVolume);
    };

    setRecording(true);
    updateVolume();
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    audioContextRef.current?.close();
    setRecording(false);
  }

  return (
    <div style={styles.container}>
      <h2>🎙️ Audio Recorder</h2>

      <button
        onClick={recording ? stopRecording : startRecording}
        style={{
          ...styles.button,
          background: recording ? "#e53935" : "#1e88e5",
        }}
      >
        {recording ? "Stop Recording" : "Start Recording"}
      </button>

      {/* Volume Meter */}
      <div style={styles.meter}>
        <div ref={volumeRef} style={styles.meterFill} />
      </div>

      {/* Waveform */}
      <div ref={waveformRef} style={{ marginTop: 20 }} />

      {audioURL && (
        <button
          style={styles.playBtn}
          onClick={() => waveSurferRef.current.playPause()}
        >
          ▶ Play / Pause
        </button>
      )}
    </div>
  );
}

const styles = {
  container: {
    maxWidth: 420,
    margin: "auto",
    padding: 20,
    textAlign: "center",
    fontFamily: "sans-serif",
  },
  button: {
    width: "100%",
    padding: 14,
    fontSize: 18,
    color: "#fff",
    border: "none",
    borderRadius: 10,
    marginBottom: 12,
  },
  meter: {
    height: 10,
    width: "100%",
    background: "#eee",
    borderRadius: 5,
    overflow: "hidden",
  },
  meterFill: {
    height: "100%",
    width: "0%",
    background: "#4caf50",
    transition: "width 0.1s",
  },
  playBtn: {
    marginTop: 10,
    padding: 10,
    fontSize: 16,
    borderRadius: 8,
    border: "1px solid #ccc",
  },
};
