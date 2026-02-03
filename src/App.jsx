import React, { useRef, useState, useEffect } from "react";

const API_BASE = "http://192.168.0.19:8000";

export default function IMUWorkoutBLE_API() {
  const imuBuffer = useRef([]);
  const charRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [services, setServices] = useState([]);
  const [characteristics, setCharacteristics] = useState([]);

  const [sensor, setSensor] = useState("-");
  const [good, setGood] = useState(0);
  const [bad, setBad] = useState(0);
  const [total, setTotal] = useState(0);
  const [reps, setReps] = useState([]);

  /* ================= BLE CONNECT ================= */
  async function connectBLE() {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [],
    });

    const server = await device.gatt.connect();
    const srvList = await server.getPrimaryServices();

    setServices(srvList);
    setConnected(true);
  }

  async function selectService(service) {
    const chars = await service.getCharacteristics();
    setCharacteristics(chars);
  }

  async function subscribeCharacteristic(char) {
    if (charRef.current) {
      try {
        await charRef.current.stopNotifications();
        charRef.current.removeEventListener(
          "characteristicvaluechanged",
          onBLEData,
        );
      } catch {}
    }

    await char.startNotifications();
    char.addEventListener("characteristicvaluechanged", onBLEData);
    charRef.current = char;
  }

  function round2(v) {
    return Number(v.toFixed(2));
  }

  function decodeIMU(value) {
    const dv = value instanceof DataView ? value : new DataView(value.buffer);

    return {
      timestamp: Date.now() / 1000, // FastAPI expects float, not Date object
      ax: round2(dv.getFloat32(0, true)),
      ay: round2(dv.getFloat32(4, true)),
      az: round2(dv.getFloat32(8, true)),
      gx: round2(dv.getFloat32(12, true)),
      gy: round2(dv.getFloat32(16, true)),
      gz: round2(dv.getFloat32(20, true)),
    };
  }

  /* ================= IMU DECODE (UNCHANGED) ================= */
  // function decodeIMU(value) {
  //   const dv = value instanceof DataView ? value : new DataView(value.buffer);
  //   return {
  //     timestamp: new Date(),
  //     ax: dv.getFloat32(0, true),
  //     ay: dv.getFloat32(4, true),
  //     az: dv.getFloat32(8, true),
  //     gx: dv.getFloat32(12, true),
  //     gy: dv.getFloat32(16, true),
  //     gz: dv.getFloat32(20, true),
  //   };
  // }

  /* ================= STREAM TO FASTAPI ================= */
  async function postIMUSample(sample) {
    try {
      await fetch(`${API_BASE}/imu`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timestamp: Date.now() / 1000,
          ...sample,
        }),
      });
    } catch (e) {
      console.error("POST imu failed", e);
    }
  }

  function onBLEData(e) {
    const sample = decodeIMU(e.target.value);
    postIMUSample(sample);
  }

  /* ================= POLL API ================= */
  async function fetchStatus() {
    const r = await fetch(`${API_BASE}/stats`);
    const d = await r.json();
    setSensor(d.sensor);
    setGood(d.good_reps);
    setBad(d.bad_reps);
    setTotal(d.total_reps);
  }

  // async function fetchReps() {
  //   const r = await fetch(`${API_BASE}/reps`);
  //   const d = await r.json();
  //   setReps(d.reps.slice(-5).reverse());
  // }

  async function resetWorkout() {
    await fetch(`${API_BASE}/reset`, { method: "POST" });
    setGood(0);
    setBad(0);
    setTotal(0);
    setReps([]);
  }

  useEffect(() => {
    const id = setInterval(() => {
      fetchStatus();
      // fetchReps();
    }, 1000);
    return () => clearInterval(id);
  }, []);

  /* ================= UI ================= */
  return (
    <div style={styles.container}>
      <h2>🏋️ Smart Rep Counter (BLE → FastAPI)</h2>

      <button onClick={connectBLE} disabled={connected}>
        {connected ? "Connected" : "Connect BLE"}
      </button>

      {connected && (
        <>
          <h4>Services</h4>
          {services.map((s) => (
            <button key={s.uuid} onClick={() => selectService(s)}>
              {s.uuid}
            </button>
          ))}
        </>
      )}

      {characteristics.length > 0 && (
        <>
          <h4>Characteristics (Notify)</h4>
          {characteristics.map((c) => (
            <button key={c.uuid} onClick={() => subscribeCharacteristic(c)}>
              {c.uuid}
            </button>
          ))}
        </>
      )}

      <div style={styles.card}>
        <p>
          <b>Sensor:</b> {sensor}
        </p>
        <p>
          <b>Total Reps:</b> {total}
        </p>
        <p style={{ color: "green" }}>Good: {good}</p>
        <p style={{ color: "red" }}>Bad: {bad}</p>
      </div>

      <button
        onClick={resetWorkout}
        style={{ background: "#dc2626", color: "#fff" }}
      >
        Reset Workout
      </button>

      <h4>Recent Reps</h4>
      {reps.map((r, i) => (
        <div key={i}>
          {r.label} ({r.start_time.toFixed(1)}s → {r.end_time.toFixed(1)}s)
        </div>
      ))}
    </div>
  );
}

const styles = {
  container: {
    maxWidth: 450,
    margin: "auto",
    padding: 20,
    fontFamily: "sans-serif",
    textAlign: "center",
  },
  card: {
    border: "1px solid #ddd",
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
  },
};
