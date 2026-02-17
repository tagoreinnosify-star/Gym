import { useEffect, useMemo, useRef, useState } from "react";

const SERVICE_UUID = "12345678-1234-5678-1234-56789abcdef0";
const NOTIFY_CHARACTERISTIC_UUID = "12345678-1234-5678-1234-56789abcdef1";

const EXERCISES = [
  { id: "squats", name: "Squats", description: "Lower-body compound squat pattern.", color: "#2f9e44", accent: "btn-green", image: "/exercises/squats.jpg" },
  { id: "deadlifts", name: "Deadlifts", description: "Posterior chain hinge lift.", color: "#087f5b", accent: "btn-main", image: "/exercises/deadlifts.jpg" },
  { id: "skull_crushers", name: "Skull Crushers", description: "Triceps extension isolation.", color: "#9c36b5", accent: "btn-purple", image: "/exercises/skull_crushers.jpg" },
  { id: "good_mornings", name: "Good Mornings", description: "Hip-hinge with spinal control.", color: "#1864ab", accent: "btn-main", image: "/exercises/good_mornings.jpg" },
  { id: "clean_jerk_snatch", name: "Clean, Jerk & Snatch", description: "Olympic explosive full-body movement.", color: "#d9480f", accent: "btn-main", image: "/exercises/clean_jerk_snatch.jpg" },
  { id: "overhead_press", name: "Overhead Press", description: "Vertical press for shoulders/triceps.", color: "#0b7285", accent: "btn-main", image: "/exercises/overhead_press.jpg" },
  { id: "romanian_deadlifts", name: "Romanian Deadlifts", description: "Hamstring-focused hinge variation.", color: "#2b8a3e", accent: "btn-green", image: "/exercises/romanian_deadlifts.jpg" },
  { id: "bent_over_rows", name: "Bent-Over Rows", description: "Horizontal pull from hinge stance.", color: "#1c7ed6", accent: "btn-main", image: "/exercises/bent_over_rows.jpg" },
  { id: "walking_lunges", name: "Walking Lunges", description: "Alternating forward lunge steps.", color: "#099268", accent: "btn-green", image: "/exercises/walking_lunges.jpg" },
  { id: "lunges", name: "Lunges", description: "Single-leg lunge stability work.", color: "#12b886", accent: "btn-green", image: "/exercises/lunges.jpg" },
  { id: "bulgarian_split_squat", name: "Bulgarian Split Squat", description: "Rear-foot elevated split squat.", color: "#3b5bdb", accent: "btn-main", image: "/exercises/bulgarian_split_squat.jpg" },
  { id: "reverse_lunges", name: "Reverse Lunges", description: "Backward stepping lunge pattern.", color: "#15aabf", accent: "btn-main", image: "/exercises/reverse_lunges.jpg" },
  { id: "chest_supported_row", name: "Chest-Supported Row", description: "Supported horizontal pulling.", color: "#1971c2", accent: "btn-main", image: "/exercises/chest_supported_row.jpg" },
  { id: "bicep_curl", name: "Bicep Curl", description: "Elbow flexion arm isolation.", color: "#37b24d", accent: "btn-green", image: "/exercises/bicep_curl.jpg" },
  { id: "hip_thrust", name: "Hip Thrust", description: "Glute-dominant hip extension.", color: "#0ca678", accent: "btn-green", image: "/exercises/hip_thrust.jpg" },
  { id: "flat_bench_press", name: "Flat Bench Press", description: "Horizontal press on flat bench.", color: "#ae3ec9", accent: "btn-purple", image: "/exercises/flat_bench_press.jpg" },
  { id: "incline_press", name: "Incline Press", description: "Upper-chest pressing angle.", color: "#7b2cbf", accent: "btn-purple", image: "/exercises/incline_press.jpg" },
  { id: "decline_press", name: "Decline Press", description: "Lower-chest pressing angle.", color: "#862e9c", accent: "btn-purple", image: "/exercises/decline_press.jpg" },
];

const DECODER_OPTIONS = [
  { value: "ble_runner_65", label: "BLE Runner 65-byte packet (<6fiI5BHB24sB)" },
  { value: "f32x6", label: "6 x float32 (ax..gz)" },
  { value: "u32_f32x6", label: "uint32 ts + 6 x float32" },
  { value: "i16x6_div1000", label: "6 x int16 / 1000" },
  { value: "u32_i16x6_div1000", label: "uint32 ts + 6 x int16 / 1000" },
];

function nowMicro() {
  return Date.now() * 1000;
}

function decodeBleRunner65(dataView) {
  const out = [];
  const little = true;
  const stride = 65;
  for (let off = 0; off + stride <= dataView.byteLength; off += stride) {
    const ax = dataView.getFloat32(off + 0, little);
    const ay = dataView.getFloat32(off + 4, little);
    const az = dataView.getFloat32(off + 8, little);
    const gx = dataView.getFloat32(off + 12, little);
    const gy = dataView.getFloat32(off + 16, little);
    const gz = dataView.getFloat32(off + 20, little);
    const battery = dataView.getInt32(off + 24, little);
    const device_timestamp_ms = dataView.getUint32(off + 28, little);
    const hours = dataView.getUint8(off + 32);
    const minutes = dataView.getUint8(off + 33);
    const seconds = dataView.getUint8(off + 34);
    const date = dataView.getUint8(off + 35);
    const month = dataView.getUint8(off + 36);
    const year = dataView.getUint16(off + 37, little);

    out.push({
      ts_micro: device_timestamp_ms > 0 ? Number(device_timestamp_ms) * 1000 : nowMicro(),
      ax,
      ay,
      az,
      gx,
      gy,
      gz,
      battery,
      device_timestamp_ms,
      device_time: { year, month, date, hours, minutes, seconds },
    });
  }
  return out;
}

function decodePacket(dataView, format) {
  const out = [];
  const little = true;

  if (format === "ble_runner_65") {
    return decodeBleRunner65(dataView);
  }

  if (format === "f32x6") {
    const stride = 24;
    for (let off = 0; off + stride <= dataView.byteLength; off += stride) {
      out.push({
        ts_micro: nowMicro(),
        ax: dataView.getFloat32(off + 0, little),
        ay: dataView.getFloat32(off + 4, little),
        az: dataView.getFloat32(off + 8, little),
        gx: dataView.getFloat32(off + 12, little),
        gy: dataView.getFloat32(off + 16, little),
        gz: dataView.getFloat32(off + 20, little),
      });
    }
  }

  if (format === "u32_f32x6") {
    const stride = 28;
    for (let off = 0; off + stride <= dataView.byteLength; off += stride) {
      out.push({
        ts_micro: Number(dataView.getUint32(off + 0, little)) * 1000,
        ax: dataView.getFloat32(off + 4, little),
        ay: dataView.getFloat32(off + 8, little),
        az: dataView.getFloat32(off + 12, little),
        gx: dataView.getFloat32(off + 16, little),
        gy: dataView.getFloat32(off + 20, little),
        gz: dataView.getFloat32(off + 24, little),
      });
    }
  }

  if (format === "i16x6_div1000") {
    const stride = 12;
    for (let off = 0; off + stride <= dataView.byteLength; off += stride) {
      out.push({
        ts_micro: nowMicro(),
        ax: dataView.getInt16(off + 0, little) / 1000,
        ay: dataView.getInt16(off + 2, little) / 1000,
        az: dataView.getInt16(off + 4, little) / 1000,
        gx: dataView.getInt16(off + 6, little) / 1000,
        gy: dataView.getInt16(off + 8, little) / 1000,
        gz: dataView.getInt16(off + 10, little) / 1000,
      });
    }
  }

  if (format === "u32_i16x6_div1000") {
    const stride = 16;
    for (let off = 0; off + stride <= dataView.byteLength; off += stride) {
      out.push({
        ts_micro: Number(dataView.getUint32(off + 0, little)) * 1000,
        ax: dataView.getInt16(off + 4, little) / 1000,
        ay: dataView.getInt16(off + 6, little) / 1000,
        az: dataView.getInt16(off + 8, little) / 1000,
        gx: dataView.getInt16(off + 10, little) / 1000,
        gy: dataView.getInt16(off + 12, little) / 1000,
        gz: dataView.getInt16(off + 14, little) / 1000,
      });
    }
  }

  return out;
}

export default function App() {
  const [selectedExercise, setSelectedExercise] = useState(null);
  const [apiBase, setApiBase] = useState("http://192.168.0.17:8000");
  const [decoderFormat, setDecoderFormat] = useState("ble_runner_65");
  const [batchInterval, setBatchInterval] = useState(1000);

  const [status, setStatus] = useState("Select an exercise to begin.");
  const [isConnected, setIsConnected] = useState(false);
  const [deviceLabel, setDeviceLabel] = useState("Unknown");
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [sessionId, setSessionId] = useState(null);

  const [packetCount, setPacketCount] = useState(0);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [bufferedCount, setBufferedCount] = useState(0);
  const [lastSample, setLastSample] = useState(null);
  const [latestBattery, setLatestBattery] = useState(null);
  const [latestDeviceTimestampMs, setLatestDeviceTimestampMs] = useState(null);
  const [latestDeviceTime, setLatestDeviceTime] = useState(null);

  const deviceRef = useRef(null);
  const notifyCharacteristicRef = useRef(null);
  const sampleBufferRef = useRef([]);
  const flushTimerRef = useRef(null);
  const sessionIdRef = useRef(null);
  const apiBaseRef = useRef(apiBase);
  const decoderFormatRef = useRef(decoderFormat);

  const selectedExerciseName = useMemo(() => {
    return selectedExercise ? selectedExercise.name : "-";
  }, [selectedExercise]);

  const pushStatus = (msg) => {
    setStatus(`[${new Date().toLocaleTimeString()}] ${msg}`);
  };

  const onCharacteristicValueChanged = (event) => {
    const value = event.target.value;
    const samples = decodePacket(value, decoderFormatRef.current);

    setPacketCount((n) => n + 1);
    if (samples.length > 0) {
      sampleBufferRef.current.push(...samples);
      setBufferedCount(sampleBufferRef.current.length);
      const latest = samples[samples.length - 1];
      setLastSample(latest);
      if (latest.battery !== undefined) {
        setLatestBattery(latest.battery);
      }
      if (latest.device_timestamp_ms !== undefined) {
        setLatestDeviceTimestampMs(latest.device_timestamp_ms);
      }
      if (latest.device_time !== undefined) {
        setLatestDeviceTime(latest.device_time);
      }
    }
  };

  const clearFlushTimer = () => {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  };

  const flushSamples = async () => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId || sampleBufferRef.current.length === 0) {
      return;
    }

    const base = apiBaseRef.current.trim().replace(/\/$/, "");
    const chunk = sampleBufferRef.current.splice(0, 500);
    const uploadSamples = chunk.map((sample) => ({
      ts_micro: sample.ts_micro,
      ax: sample.ax,
      ay: sample.ay,
      az: sample.az,
      gx: sample.gx,
      gy: sample.gy,
      gz: sample.gz,
    }));

    const res = await fetch(`${base}/sessions/${currentSessionId}/imu/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ samples: uploadSamples }),
    });

    if (!res.ok) {
      sampleBufferRef.current.unshift(...chunk);
      setBufferedCount(sampleBufferRef.current.length);
      throw new Error(`Upload failed: HTTP ${res.status}`);
    }

    setUploadedCount((n) => n + chunk.length);
    setBufferedCount(sampleBufferRef.current.length);
  };

  const disconnectBle = async () => {
    clearFlushTimer();

    if (notifyCharacteristicRef.current) {
      try {
        notifyCharacteristicRef.current.removeEventListener("characteristicvaluechanged", onCharacteristicValueChanged);
        await notifyCharacteristicRef.current.stopNotifications();
      } catch (_err) {
      }
      notifyCharacteristicRef.current = null;
    }

    if (deviceRef.current?.gatt?.connected) {
      deviceRef.current.gatt.disconnect();
    }

    setIsConnected(false);
    setNotifyEnabled(false);
    setDeviceLabel("Unknown");
    pushStatus("BLE disconnected.");
  };

  const connectBle = async () => {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth is not available in this browser.");
    }

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID],
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const characteristic = await service.getCharacteristic(NOTIFY_CHARACTERISTIC_UUID);

    deviceRef.current = device;
    notifyCharacteristicRef.current = characteristic;

    device.addEventListener("gattserverdisconnected", () => {
      clearFlushTimer();
      setIsConnected(false);
      setNotifyEnabled(false);
      pushStatus("Device disconnected from BLE.");
    });

    characteristic.addEventListener("characteristicvaluechanged", onCharacteristicValueChanged);
    await characteristic.startNotifications();

    setDeviceLabel(device.name || "Unknown");
    setIsConnected(true);
    setNotifyEnabled(true);
    pushStatus(`Connected: ${device.name || "Unknown"} | Notify ON (${NOTIFY_CHARACTERISTIC_UUID})`);
  };

  const startSession = async () => {
    if (!isConnected || !notifyEnabled) {
      throw new Error("Connect BLE first. Notify must be ON.");
    }

    const base = apiBase.trim().replace(/\/$/, "");
    const payload = {
      exercise_name: selectedExerciseName.toLowerCase().replace(/[\s,&-]+/g, "_").replace(/^_|_$/g, ""),
      start_time: new Date().toISOString(),
    };

    const res = await fetch(`${base}/sessions/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Start session failed: HTTP ${res.status}`);
    }

    const data = await res.json();
    sampleBufferRef.current = [];
    setBufferedCount(0);
    setUploadedCount(0);
    setPacketCount(0);
    setLastSample(null);
    setLatestBattery(null);
    setLatestDeviceTimestampMs(null);
    setLatestDeviceTime(null);
    setSessionId(data.session_id);
    sessionIdRef.current = data.session_id;

    clearFlushTimer();
    const intervalMs = Math.max(200, Number(batchInterval || 1000));
    flushTimerRef.current = setInterval(() => {
      flushSamples().catch((err) => pushStatus(err.message));
    }, intervalMs);

    pushStatus(`Session ${data.session_id} started.`);
  };

  const stopSession = async () => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      return;
    }

    clearFlushTimer();
    await flushSamples();

    const base = apiBaseRef.current.trim().replace(/\/$/, "");
    const res = await fetch(`${base}/sessions/${currentSessionId}/complete`, { method: "POST" });

    if (!res.ok) {
      throw new Error(`Complete session failed: HTTP ${res.status}`);
    }

    pushStatus(`Session ${currentSessionId} completed.`);
    setSessionId(null);
    sessionIdRef.current = null;
  };

  useEffect(() => {
    apiBaseRef.current = apiBase;
  }, [apiBase]);

  useEffect(() => {
    decoderFormatRef.current = decoderFormat;
  }, [decoderFormat]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    return () => {
      clearFlushTimer();
    };
  }, []);

  if (!selectedExercise) {
    return (
      <main className="app">
        <section className="hero">
          <h1>Select Your Exercise</h1>
          <p>Choose the movement and then connect BLE to stream and upload IMU data.</p>
        </section>

        <section className="exercise-grid">
          {EXERCISES.map((exercise, idx) => (
            <article key={exercise.id} className="card" style={{ animationDelay: `${idx * 45}ms` }}>
              <div className="exercise-thumb" style={{ color: exercise.color }}>
                <img
                  src={exercise.image}
                  alt={exercise.name}
                  className="exercise-image"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              </div>
              <h2 className="exercise-name" style={{ color: exercise.color }}>{exercise.name}</h2>
              <p className="exercise-note">{exercise.description}</p>
              <button className={`btn ${exercise.accent}`} onClick={() => setSelectedExercise(exercise)}>
                Select Exercise
              </button>
            </article>
          ))}
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      <section className="hero">
        <div className="heading-row">
          <div className="exercise-header-copy">
            <h1>{selectedExercise.name}</h1>
            <p>BLE notification stream and API ingestion dashboard.</p>
            <button className="btn btn-sub hero-back-btn" onClick={() => setSelectedExercise(null)}>
              Back
            </button>
          </div>
          <div className="exercise-visual">
            <div className="exercise-image-card">
              <img src={selectedExercise.image} alt={selectedExercise.name} className="exercise-header-image" />
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="row">
          <button className={`btn ${isConnected ? "btn-green" : "btn-main"}`} onClick={async () => {
            try {
              await connectBle();
            } catch (err) {
              pushStatus(err.message);
            }
          }} disabled={isConnected}>
            {isConnected ? "Connected" : "Connect BLE"}
          </button>

          <button className="btn btn-red" onClick={async () => {
            try {
              await disconnectBle();
            } catch (err) {
              pushStatus(err.message);
            }
          }}>
            Disconnect
          </button>

          <button className="btn btn-purple" onClick={async () => {
            try {
              await startSession();
            } catch (err) {
              pushStatus(err.message);
            }
          }}>
            Start Session
          </button>

          <button className="btn btn-main" onClick={async () => {
            try {
              await stopSession();
            } catch (err) {
              pushStatus(err.message);
            }
          }}>
            Stop Session
          </button>
        </div>

        <div className="fields">
          <div className="field">
            <label>API Base URL</label>
            <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
          </div>
          <div className="field">
            <label>Decoder Format</label>
            <select value={decoderFormat} onChange={(e) => setDecoderFormat(e.target.value)}>
              {DECODER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Batch Upload Interval (ms)</label>
            <input
              type="number"
              min="200"
              step="100"
              value={batchInterval}
              onChange={(e) => setBatchInterval(Number(e.target.value || 1000))}
            />
          </div>
        </div>

        <div className="status">{status}</div>
      </section>

      <section className="panel">
        <h3 className="section-title">Connection</h3>
        <div className="chips">
          <span className="chip">{deviceLabel || "Unknown"}</span>
          <span className="chip">{SERVICE_UUID}</span>
          <span className="chip">-&gt; {NOTIFY_CHARACTERISTIC_UUID} Notify {notifyEnabled ? "ON" : "OFF"}</span>
        </div>
      </section>

      <section className="panel">
        <h3 className="section-title">Session Summary</h3>
        <div className="meta">
          <div>
            <small>Exercise</small>
            <strong>{selectedExercise.name}</strong>
          </div>
          <div>
            <small>Session ID</small>
            <strong>{sessionId || "-"}</strong>
          </div>
          <div>
            <small>Packets Decoded</small>
            <strong>{packetCount}</strong>
          </div>
          <div>
            <small>Samples Buffered</small>
            <strong>{bufferedCount}</strong>
          </div>
          <div>
            <small>Samples Uploaded</small>
            <strong>{uploadedCount}</strong>
          </div>
          <div>
            <small>Battery</small>
            <strong>{latestBattery ?? "-"}</strong>
          </div>
          <div>
            <small>Device Timestamp (ms)</small>
            <strong>{latestDeviceTimestampMs ?? "-"}</strong>
          </div>
          <div>
            <small>Device Time</small>
            <strong>
              {latestDeviceTime
                ? `${String(latestDeviceTime.hours).padStart(2, "0")}:${String(latestDeviceTime.minutes).padStart(2, "0")}:${String(latestDeviceTime.seconds).padStart(2, "0")} ${String(latestDeviceTime.date).padStart(2, "0")}/${String(latestDeviceTime.month).padStart(2, "0")}/${latestDeviceTime.year}`
                : "-"}
            </strong>
          </div>
        </div>
      </section>

      <section className="panel">
        <h3 className="section-title">Last Decoded Sample</h3>
        <pre className="sample">{lastSample ? JSON.stringify(lastSample, null, 2) : "No sample yet."}</pre>
      </section>
    </main>
  );
}
