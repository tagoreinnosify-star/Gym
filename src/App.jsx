import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
  Legend,
} from "recharts";
import * as XLSX from "xlsx";

/* ================= Z-AXIS LOCKED DETECTOR ================= */
// Hard-locked to Z-axis for best accuracy
// All movement counted as reps, categorized by axis

const FS = 50;
const LOOKBACK_SAMPLES = 50; // rep detection buffer

const LP_ALPHA = 0.5;
const Z_AXIS_INDEX = 2; // Hard lock to Z-axis (index 2)

// Thresholds (tune per sensor)
const REP_PEAK_THRESH = 2.5;
const MIN_REP_MS = 900;
const MIN_REP_ENERGY = 2.0;

function createZAxisDetector() {
  let state = "READY";
  let lockedAxis = Z_AXIS_INDEX; // Always Z-axis

  // Signal tracking
  let zLp = 0;
  let xLp = 0;
  let yLp = 0;
  let lastRepTime = 0;

  let goodReps = 0;  // Z-axis reps
  let badReps = 0;   // X/Y-axis reps
  let missedReps = 0;
  let totalEnergy = 0;

  let lookbackZ = [];
  let lookbackX = [];
  let lookbackY = [];

  // ---------------- UTIL ----------------
  function detectAnyPeak(signals) {
    if (signals.length < 3) return false;
    const n = signals.length;
    return signals[n - 2] > signals[n - 3] && signals[n - 2] > signals[n - 1];
  }

  function calculateAxisEnergy(gyro) {
    const absGyro = gyro.map(Math.abs);
    
    // Apply low-pass filtering to each axis
    xLp = LP_ALPHA * absGyro[0] + (1 - LP_ALPHA) * xLp;
    yLp = LP_ALPHA * absGyro[1] + (1 - LP_ALPHA) * yLp;
    zLp = LP_ALPHA * absGyro[2] + (1 - LP_ALPHA) * zLp;

    // Update lookback buffers
    lookbackX.push(xLp);
    lookbackY.push(yLp);
    lookbackZ.push(zLp);
    
    if (lookbackX.length > LOOKBACK_SAMPLES) {
      lookbackX.shift();
      lookbackY.shift();
      lookbackZ.shift();
    }

    // Calculate total energy (sum of all axes)
    totalEnergy = (xLp + yLp + zLp) / FS;

    return {
      x: xLp,
      y: yLp,
      z: zLp,
      absGyro,
    };
  }

  function detectRepOnAxis(axisSignal, axisLookback, axisName, timestamp) {
    if (detectAnyPeak(axisLookback)) {
      const peakVal = axisLookback[axisLookback.length - 2];
      const dt = timestamp - lastRepTime;

      if (peakVal > REP_PEAK_THRESH && dt > MIN_REP_MS) {
        lastRepTime = timestamp;
        
        if (axisName === 'z') {
          goodReps++;
          return { detected: true, type: 'GOOD', axis: 'Z' };
        } else {
          badReps++;
          return { detected: true, type: 'BAD', axis: axisName.toUpperCase() };
        }
      }
    }
    return { detected: false };
  }

  // ---------------- UPDATE ----------------
  function update(gyro) {
    const timestamp = Date.now();
    
    // Calculate axis energies
    const energies = calculateAxisEnergy(gyro);
    
    let repDetected = false;
    let repType = null;
    let repAxis = null;

    // Check Z-axis first (good reps)
    const zResult = detectRepOnAxis(energies.z, lookbackZ, 'z', timestamp);
    if (zResult.detected) {
      repDetected = true;
      repType = zResult.type;
      repAxis = zResult.axis;
    } else {
      // Check X and Y axes for bad reps
      const xResult = detectRepOnAxis(energies.x, lookbackX, 'x', timestamp);
      if (xResult.detected) {
        repDetected = true;
        repType = xResult.type;
        repAxis = xResult.axis;
      } else {
        const yResult = detectRepOnAxis(energies.y, lookbackY, 'y', timestamp);
        if (yResult.detected) {
          repDetected = true;
          repType = yResult.type;
          repAxis = yResult.axis;
        }
      }
    }

    // Missed rep detection based on total energy
    if (!repDetected && lookbackZ.length === LOOKBACK_SAMPLES) {
      const energy = lookbackZ.reduce((a, b) => a + b, 0) / FS;
      if (energy > MIN_REP_ENERGY && timestamp - lastRepTime > 2000) {
        missedReps++;
        lastRepTime = timestamp;
        repDetected = true;
        repType = "MISSED";
      }
    }

    // Calculate axis ratios for display
    const total = energies.x + energies.y + energies.z;
    const energyRatio = [
      total > 0 ? energies.x / total : 0,
      total > 0 ? energies.y / total : 0,
      total > 0 ? energies.z / total : 0
    ];

    // Determine which axis is most active in this sample
    const axisEnergies = [energies.x, energies.y, energies.z];
    const maxEnergyIndex = axisEnergies.indexOf(Math.max(...axisEnergies));
    const dominantAxis = ['X', 'Y', 'Z'][maxEnergyIndex];

    return {
      state,
      lockedAxis,
      goodReps,
      badReps,
      missedReps,
      repDetected,
      repType,
      repAxis,
      signal: energies.z,  // Primary signal from Z-axis
      xSignal: energies.x,
      ySignal: energies.y,
      zSignal: energies.z,
      energyRatio,
      dominantAxis,
      totalEnergy,
      gx: gyro[0],
      gy: gyro[1],
      gz: gyro[2],
      absGx: energies.absGyro[0],
      absGy: energies.absGyro[1],
      absGz: energies.absGyro[2],
      timestamp,
    };
  }

  // ----------- RESET -----------
  function reset() {
    state = "READY";
    zLp = 0;
    xLp = 0;
    yLp = 0;
    lastRepTime = 0;
    
    lookbackZ = [];
    lookbackX = [];
    lookbackY = [];

    goodReps = 0;
    badReps = 0;
    missedReps = 0;
    totalEnergy = 0;
  }

  return { update, reset };
}

const log = [];

/* ================= CSV PROCESSOR ================= */
function createCSVProcessor() {
  let csvData = [];
  let currentIndex = 0;
  let detector = null;

  function parseCSV(csvText) {
    const lines = csvText.split('\n');
    const headers = lines[0].split(',');

    csvData = lines.slice(1).filter(line => line.trim()).map(line => {
      const values = line.split(',');
      const obj = {};
      headers.forEach((header, index) => {
        const value = values[index] ? values[index].trim() : '';
        if (header === 'phase' || header === 'exercise') {
          obj[header] = value;
        } else if (header === 'rep') {
          obj[header] = value ? parseInt(value) : null;
        } else {
          obj[header] = value ? parseFloat(value) : 0;
        }
      });
      return obj;
    });

    currentIndex = 0;
    detector = createZAxisDetector();
  }

  function getNextSample() {
    if (currentIndex >= csvData.length) return null;

    const sample = csvData[currentIndex];
    currentIndex++;

    // Convert to arrays
    const gyro = [sample.gx, sample.gy, sample.gz];
    
    // Process through detector
    const result = detector.update(gyro);

    // Log for comparison
    log.push({
      ...sample,
      detectedRep: result.repDetected,
      detectedRepType: result.repType,
      detectedAxis: result.repAxis,
      zSignal: result.zSignal,
      timestamp: Date.now(),
    });

    return {
      ...result,
      groundTruth: {
        exercise: sample.exercise,
        phase: sample.phase,
        rep: sample.rep,
      }
    };
  }

  function getAllData() {
    return csvData;
  }

  function reset() {
    csvData = [];
    currentIndex = 0;
    if (detector) detector.reset();
  }

  return { parseCSV, getNextSample, getAllData, reset };
}

/* ================= MAIN APP ================= */
export default function DumbbellRepCounter() {
  // Refs for BLE and detector
  const detectorRef = useRef(createZAxisDetector());
  const csvProcessorRef = useRef(createCSVProcessor());
  const deviceRef = useRef(null);
  const charRef = useRef(null);
  const rafRef = useRef(null);
  const notificationHandlerRef = useRef(null);
  const startedRef = useRef(false);

  // Latest sensor data and detection results
  const latestRef = useRef({
    goodReps: 0,
    badReps: 0,
    missedReps: 0,
    repDetected: false,
    repType: null,
    repAxis: null,
    state: "READY",
    lockedAxis: 2, // Z-axis
    signal: 0,
    xSignal: 0,
    ySignal: 0,
    zSignal: 0,
    energyRatio: [0, 0, 0],
    dominantAxis: "Z",
    totalEnergy: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    lastUpdate: Date.now(),
  });

  // State
  const [services, setServices] = useState([]);
  const [characteristics, setCharacteristics] = useState([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [dataRate, setDataRate] = useState(0);
  const [goodReps, setGoodReps] = useState(0);
  const [badReps, setBadReps] = useState(0);
  const [missedReps, setMissedReps] = useState(0);
  const [graphData, setGraphData] = useState([]);
  const [repMarks, setRepMarks] = useState([]);
  const [lastDataTime, setLastDataTime] = useState(null);
  const [dataCount, setDataCount] = useState(0);
  const [csvMode, setCsvMode] = useState(false);
  const [csvFile, setCsvFile] = useState(null);
  const [processingCSV, setProcessingCSV] = useState(false);
  const [lastRepInfo, setLastRepInfo] = useState(null);

  // Data rate calculation
  const dataRateRef = useRef({ count: 0, lastCalc: Date.now() });

  /* ================= CSV HANDLING ================= */
  const handleCSVUpload = useCallback((event) => {
    const file = event.target.files[0];
    if (!file) return;

    setCsvFile(file);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        csvProcessorRef.current.parseCSV(e.target.result);
        setCsvMode(true);
        setProcessingCSV(true);
        setError(null);
        console.log("CSV loaded successfully");
      } catch (err) {
        setError(`CSV parsing error: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }, []);

  const processNextCSVSample = useCallback(() => {
    if (!processingCSV) return;

    const result = csvProcessorRef.current.getNextSample();

    if (!result) {
      setProcessingCSV(false);
      console.log("CSV processing complete");
      return;
    }

    // Update state with CSV results
    latestRef.current = {
      ...result,
      lastUpdate: Date.now(),
    };

    setLastDataTime(Date.now());
    setDataCount(prev => prev + 1);

    // Schedule next sample (simulate 100ms intervals as in your CSV)
    setTimeout(processNextCSVSample, 100);
  }, [processingCSV]);

  /* ================= BLE FUNCTIONS ================= */
  const connectBLE = useCallback(async () => {
    try {
      setError(null);
      setIsScanning(true);

      if (!navigator.bluetooth) {
        throw new Error("Web Bluetooth API not supported in this browser");
      }

      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [
          "12345678-1234-5678-1234-56789abcdef0",
        ],
      });

      if (!device) {
        throw new Error("No device selected");
      }

      deviceRef.current = device;

      const handleDisconnect = () => {
        setConnected(false);
        setServices([]);
        setCharacteristics([]);
        if (charRef.current) {
          charRef.current.removeEventListener(
            "characteristicvaluechanged",
            notificationHandlerRef.current,
          );
          charRef.current = null;
        }
        setError("Device disconnected");
        setIsScanning(false);
      };

      device.addEventListener("gattserverdisconnected", handleDisconnect);

      const server = await device.gatt.connect();
      setConnected(true);
      setIsScanning(false);

      const servicesList = await server.getPrimaryServices();
      setServices(servicesList);

      console.log(
        "Found services:",
        servicesList.map((s) => s.uuid),
      );
    } catch (err) {
      setError(`Connection failed: ${err.message}`);
      setIsScanning(false);
      console.error("BLE Connection Error:", err);
    }
  }, []);

  const selectService = useCallback(async (service) => {
    try {
      setError(null);
      const chars = await service.getCharacteristics();
      console.log(`Service ${service.uuid} characteristics:`, chars);
      const notifyChars = chars.filter(
        (c) => c.properties.notify || c.properties.indicate,
      );
      setCharacteristics(notifyChars);

      if (notifyChars.length === 0) {
        setError("No notify/indicate characteristics found in this service");
      }
    } catch (err) {
      setError(`Service error: ${err.message}`);
    }
  }, []);

  const subscribeCharacteristic = useCallback(async (characteristic) => {
    try {
      setError(null);

      if (charRef.current && notificationHandlerRef.current) {
        await charRef.current.stopNotifications();
        charRef.current.removeEventListener(
          "characteristicvaluechanged",
          notificationHandlerRef.current,
        );
      }

      charRef.current = characteristic;
      await characteristic.startNotifications();

      const handleNotify = (event) => {
        const dataView = event.target.value;
        try {
          if (dataView.byteLength < 24) {
            console.warn("Data too short:", dataView.byteLength);
            return;
          }

          const ax = dataView.getFloat32(0, true);
          const ay = dataView.getFloat32(4, true);
          const az = dataView.getFloat32(8, true);
          const gx = dataView.getFloat32(12, true);
          const gy = dataView.getFloat32(16, true);
          const gz = dataView.getFloat32(20, true);

          log.push({
            ax, ay, az,
            gx, gy, gz,
            timestamp: Date.now(),
          });

          dataRateRef.current.count++;
          const now = Date.now();
          if (now - dataRateRef.current.lastCalc > 1000) {
            setDataRate(dataRateRef.current.count);
            dataRateRef.current = { count: 0, lastCalc: now };
          }

          const result = detectorRef.current.update([gx, gy, gz]);

          latestRef.current = {
            ...result,
            lastUpdate: now,
            rawAcc: [ax, ay, az],
            rawGyro: [gx, gy, gz],
          };

          if (!startedRef.current) startedRef.current = true;

          setLastDataTime(now);
          setDataCount((prev) => prev + 1);
        } catch (parseErr) {
          console.error("Data parsing error:", parseErr);
          try {
            const int16View = new Int16Array(dataView.buffer);
            if (int16View.length >= 6) {
              const scale = 16384.0;
              const ax = int16View[0] / scale;
              const ay = int16View[1] / scale;
              const az = int16View[2] / scale;
              const gx = int16View[3] / 131.0;
              const gy = int16View[4] / 131.0;
              const gz = int16View[5] / 131.0;

              const result = detectorRef.current.update([gx, gy, gz]);
              latestRef.current = {
                ...result,
                lastUpdate: Date.now(),
                rawAcc: [ax, ay, az],
                rawGyro: [gx, gy, gz],
              };
            }
          } catch (altErr) {
            console.error("Alternative parsing failed:", altErr);
          }
        }
      };

      notificationHandlerRef.current = handleNotify;
      characteristic.addEventListener(
        "characteristicvaluechanged",
        handleNotify,
      );

      setError(`Subscribed to ${characteristic.uuid}`);
    } catch (err) {
      setError(`Subscription failed: ${err.message}`);
      charRef.current = null;
    }
  }, []);

  const exportToExcel = () => {
    const wb = XLSX.utils.book_new();
    
    // Add sensor data
    const ws1 = XLSX.utils.json_to_sheet(log.map(entry => ({
      timestamp: new Date(entry.timestamp).toISOString(),
      gx: entry.gx?.toFixed(4),
      gy: entry.gy?.toFixed(4),
      gz: entry.gz?.toFixed(4),
      repType: entry.detectedRepType || 'none',
      repAxis: entry.detectedAxis || 'none',
      zSignal: entry.zSignal?.toFixed(4),
    })));
    
    // Add rep summary
    const totalReps = goodReps + badReps;
    const accuracy = totalReps > 0 ? (goodReps / totalReps) * 100 : 0;
    
    const summary = [
      ["BICEP CURL ANALYSIS - Z-AXIS LOCKED"],
      ["=".repeat(40)],
      ["REP CATEGORY", "COUNT", "PERCENTAGE"],
      ["Z-Axis (Good Form)", goodReps, `${((goodReps / totalReps || 0) * 100).toFixed(1)}%`],
      ["X/Y-Axis (Wrong Form)", badReps, `${((badReps / totalReps || 0) * 100).toFixed(1)}%`],
      ["=".repeat(40)],
      ["TOTAL REPS", totalReps, "100%"],
      ["FORM ACCURACY", `${accuracy.toFixed(1)}%`, ""],
      ["MISSED REPS", missedReps, ""],
      ["=".repeat(40)],
      ["CONFIGURATION", "VALUE", ""],
      ["Locked Axis", "Z-Axis", ""],
      ["Detection Method", "Peak Detection", ""],
      ["Sample Rate", `${dataRate} Hz`, ""],
      ["Total Data Points", dataCount, ""],
    ];
    
    const ws2 = XLSX.utils.aoa_to_sheet(summary);
    
    XLSX.utils.book_append_sheet(wb, ws1, "Sensor_Data");
    XLSX.utils.book_append_sheet(wb, ws2, "Summary");
    XLSX.writeFile(wb, `Bicep_Curl_ZAxis_Analysis_${Date.now()}.xlsx`);
  };

  const disconnectBLE = useCallback(async () => {
    try {
      if (charRef.current && notificationHandlerRef.current) {
        await charRef.current.stopNotifications();
        charRef.current.removeEventListener(
          "characteristicvaluechanged",
          notificationHandlerRef.current,
        );
        charRef.current = null;
      }

      if (deviceRef.current) {
        if (deviceRef.current.gatt.connected) {
          deviceRef.current.gatt.disconnect();
        }
        deviceRef.current = null;
      }

      setConnected(false);
      setServices([]);
      setCharacteristics([]);
      setError(null);
      setIsScanning(false);
    } catch (err) {
      console.error("Disconnect error:", err);
      setError(`Disconnect error: ${err.message}`);
    }
  }, []);

  const resetCounts = useCallback(() => {
    detectorRef.current.reset();
    csvProcessorRef.current.reset();
    latestRef.current = {
      goodReps: 0,
      badReps: 0,
      missedReps: 0,
      repDetected: false,
      repType: null,
      repAxis: null,
      state: "READY",
      lockedAxis: 2,
      signal: 0,
      xSignal: 0,
      ySignal: 0,
      zSignal: 0,
      energyRatio: [0, 0, 0],
      dominantAxis: "Z",
      totalEnergy: 0,
      gx: 0,
      gy: 0,
      gz: 0,
      lastUpdate: Date.now(),
    };
    startedRef.current = false;
    setGoodReps(0);
    setBadReps(0);
    setMissedReps(0);
    setGraphData([]);
    setRepMarks([]);
    setDataRate(0);
    dataRateRef.current = { count: 0, lastCalc: Date.now() };
    setCsvMode(false);
    setProcessingCSV(false);
    setLastRepInfo(null);
  }, []);

  /* ================= UI UPDATE LOOP ================= */
  useEffect(() => {
    let lastGraphUpdate = 0;
    const GRAPH_UPDATE_MS = 50; // 50ms for smoother updates

    const updateLoop = () => {
      const now = Date.now();
      const data = latestRef.current;

      // Update counts
      setGoodReps(data.goodReps);
      setBadReps(data.badReps);
      setMissedReps(data.missedReps);

      // Update last rep info
      if (data.repDetected) {
        setLastRepInfo({
          type: data.repType,
          axis: data.repAxis,
          time: now,
          signal: data.signal,
        });
      }

      if (!startedRef.current) {
        rafRef.current = requestAnimationFrame(updateLoop);
        return;
      }

      if (now - lastGraphUpdate >= GRAPH_UPDATE_MS) {
        lastGraphUpdate = now;
        
        // Update graph data
        setGraphData((prev) => {
          const newPoint = {
            time: now,
            zSignal: data.zSignal || 0,
            xSignal: data.xSignal || 0,
            ySignal: data.ySignal || 0,
            gx: data.gx || 0,
            gy: data.gy || 0,
            gz: data.gz || 0,
            dominantAxis: data.dominantAxis,
          };
          
          const newData = [...prev.slice(-200), newPoint];
          return newData;
        });

        // Update rep marks
        if (data.repDetected) {
          setRepMarks((prev) => {
            const newMark = {
              time: now,
              value: data.signal,
              type: data.repType,
              axis: data.repAxis,
            };
            return [...prev.slice(-30), newMark];
          });
        }
      }

      rafRef.current = requestAnimationFrame(updateLoop);
    };

    rafRef.current = requestAnimationFrame(updateLoop);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // Start CSV processing when mode is enabled
  useEffect(() => {
    if (csvMode && processingCSV) {
      processNextCSVSample();
    }
  }, [csvMode, processingCSV, processNextCSVSample]);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      disconnectBLE();
    };
  }, [disconnectBLE]);

  // Calculate total reps and accuracy
  const totalReps = goodReps + badReps;
  const accuracy = totalReps > 0 ? (goodReps / totalReps) * 100 : 0;

  /* ================= RENDER ================= */
  return (
    <div
      style={{
        padding: "20px",
        width: "100vw",
        margin: "0 auto",
        fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
        backgroundColor: "#f5f5f5",
        minHeight: "100vh",
      }}
    >
      <div
        style={{
          backgroundColor: "white",
          borderRadius: "12px",
          padding: "24px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          marginBottom: "24px",
        }}
      >
        <h1
          style={{
            margin: "0 0 20px 0",
            color: "#2c3e50",
            fontSize: "28px",
            fontWeight: "600",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span>🎯 Z-Axis Locked Bicep Curl Counter</span>
          <button
            onClick={exportToExcel}
            style={{
              padding: "8px 16px",
              backgroundColor: "#4CAF50",
              color: "white",
              border: "none",
              borderRadius: "8px",
              fontSize: "14px",
              fontWeight: "500",
              cursor: "pointer",
            }}
          >
            📊 Export Data
          </button>
        </h1>
        
        {/* Connection Status */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "20px",
            marginBottom: "24px",
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: "12px",
              alignItems: "center",
            }}
          >
            <button
              onClick={connectBLE}
              disabled={connected || isScanning || csvMode}
              style={{
                padding: "12px 24px",
                backgroundColor: connected
                  ? "#4CAF50"
                  : isScanning
                    ? "#FF9800"
                    : "#2196F3",
                color: "white",
                border: "none",
                borderRadius: "8px",
                fontSize: "16px",
                fontWeight: "500",
                cursor: (connected || isScanning || csvMode) ? "not-allowed" : "pointer",
                minWidth: "150px",
                opacity: (connected || isScanning || csvMode) ? 0.8 : 1,
              }}
            >
              {isScanning
                ? "🔍 Scanning..."
                : connected
                  ? "✅ Connected"
                  : "📡 Connect BLE"}
            </button>
            
            {connected && (
              <button
                onClick={disconnectBLE}
                style={{
                  padding: "12px 24px",
                  backgroundColor: "#f44336",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  fontSize: "16px",
                  fontWeight: "500",
                  cursor: "pointer",
                }}
              >
                Disconnect
              </button>
            )}
            
            <input
              type="file"
              accept=".csv"
              onChange={handleCSVUpload}
              style={{ display: "none" }}
              id="csv-upload"
            />
            <label
              htmlFor="csv-upload"
              style={{
                padding: "12px 24px",
                backgroundColor: csvMode ? "#9c27b0" : "#673ab7",
                color: "white",
                border: "none",
                borderRadius: "8px",
                fontSize: "16px",
                fontWeight: "500",
                cursor: "pointer",
                display: "inline-block",
              }}
            >
              {csvMode ? "📁 CSV Loaded" : "📁 Upload CSV"}
            </label>
            
            <button
              onClick={resetCounts}
              style={{
                padding: "12px 24px",
                backgroundColor: "#ff9800",
                color: "white",
                border: "none",
                borderRadius: "8px",
                fontSize: "16px",
                fontWeight: "500",
                cursor: "pointer",
              }}
            >
              🔄 Reset All
            </button>
          </div>
          
          <div
            style={{
              display: "flex",
              gap: "20px",
              alignItems: "center",
              marginLeft: "auto",
            }}
          >
            {csvMode && (
              <div
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#9c27b0",
                  borderRadius: "8px",
                  fontSize: "14px",
                  color: "white",
                  fontWeight: "500",
                }}
              >
                📊 CSV Mode
              </div>
            )}
            
            {dataRate > 0 && (
              <div
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#e8f5e9",
                  borderRadius: "8px",
                  fontSize: "14px",
                  color: "#2e7d32",
                  fontWeight: "500",
                }}
              >
                📊 {dataRate} Hz
              </div>
            )}
            
            <div
              style={{
                padding: "8px 16px",
                backgroundColor: "#e3f2fd",
                borderRadius: "8px",
                fontSize: "14px",
                color: "#1565c0",
                fontWeight: "600",
              }}
            >
              🔒 Z-Axis Locked
            </div>
          </div>
        </div>
        
        {/* Summary Stats */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
            gap: "16px",
            marginBottom: "24px",
          }}
        >
          {/* Total Reps */}
          <div
            style={{
              backgroundColor: "#e3f2fd",
              borderRadius: "10px",
              padding: "20px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: "14px", color: "#1565c0", marginBottom: "8px" }}>
              TOTAL REPS
            </div>
            <div style={{ fontSize: "36px", fontWeight: "700", color: "#0d47a1" }}>
              {totalReps}
            </div>
            <div style={{ fontSize: "12px", color: "#666", marginTop: "4px" }}>
              Z: {goodReps} | X/Y: {badReps}
            </div>
          </div>
          
          {/* Form Accuracy */}
          <div
            style={{
              backgroundColor: accuracy > 70 ? "#e8f5e9" : accuracy > 50 ? "#fff3e0" : "#ffebee",
              borderRadius: "10px",
              padding: "20px",
              textAlign: "center",
              border: accuracy > 70 ? "2px solid #4CAF50" : accuracy > 50 ? "2px solid #FF9800" : "2px solid #f44336",
            }}
          >
            <div style={{ fontSize: "14px", color: accuracy > 70 ? "#2e7d32" : accuracy > 50 ? "#f57c00" : "#c62828", marginBottom: "8px", fontWeight: "600" }}>
              FORM ACCURACY
            </div>
            <div style={{ fontSize: "36px", fontWeight: "700", color: accuracy > 70 ? "#1b5e20" : accuracy > 50 ? "#ff9800" : "#d32f2f" }}>
              {accuracy.toFixed(1)}%
            </div>
            <div style={{ fontSize: "12px", color: "#666", marginTop: "4px" }}>
              Z-axis reps / Total reps
            </div>
          </div>
          
          {/* Current Activity */}
          <div
            style={{
              backgroundColor: "#f8f9fa",
              borderRadius: "10px",
              padding: "20px",
              textAlign: "center",
              border: "1px solid #dee2e6",
            }}
          >
            <div style={{ fontSize: "14px", color: "#495057", marginBottom: "8px" }}>
              CURRENT ACTIVITY
            </div>
            <div style={{ fontSize: "18px", fontWeight: "600", color: latestRef.current.dominantAxis === "Z" ? "#4CAF50" : "#f44336" }}>
              {latestRef.current.dominantAxis}-Axis Active
            </div>
            {lastRepInfo && (
              <div style={{ fontSize: "12px", color: "#666", marginTop: "8px", padding: "4px", backgroundColor: "#f0f0f0", borderRadius: "4px" }}>
                Last rep: {lastRepInfo.type} ({lastRepInfo.axis})
              </div>
            )}
          </div>
        </div>
        
        {/* Detailed Rep Counters */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "16px",
            marginBottom: "32px",
          }}
        >
          {/* Z-Axis Reps (GOOD) */}
          <div
            style={{
              backgroundColor: "#e8f5e9",
              borderRadius: "10px",
              padding: "24px",
              textAlign: "center",
              boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
              border: "3px solid #4CAF50",
            }}
          >
            <div style={{ fontSize: "16px", color: "#2e7d32", marginBottom: "12px", fontWeight: "600" }}>
              ✅ Z-AXIS REPS
            </div>
            <div style={{ fontSize: "48px", fontWeight: "800", color: "#1b5e20" }}>
              {goodReps}
            </div>
            <div style={{ fontSize: "14px", color: "#666", marginTop: "12px" }}>
              Good Form - Correct motion
            </div>
          </div>

          {/* X/Y-Axis Reps (BAD) */}
          <div
            style={{
              backgroundColor: "#ffebee",
              borderRadius: "10px",
              padding: "24px",
              textAlign: "center",
              boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
              border: "3px solid #f44336",
            }}
          >
            <div style={{ fontSize: "16px", color: "#c62828", marginBottom: "12px", fontWeight: "600" }}>
              ❌ X/Y-AXIS REPS
            </div>
            <div style={{ fontSize: "48px", fontWeight: "800", color: "#b71c1c" }}>
              {badReps}
            </div>
            <div style={{ fontSize: "14px", color: "#666", marginTop: "12px" }}>
              Wrong Form - Sideways motion
            </div>
          </div>

          {/* Axis Distribution */}
          <div
            style={{
              backgroundColor: "#fff3e0",
              borderRadius: "10px",
              padding: "24px",
              textAlign: "center",
              boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
              border: "3px solid #FF9800",
            }}
          >
            <div style={{ fontSize: "16px", color: "#f57c00", marginBottom: "12px", fontWeight: "600" }}>
              📊 AXIS DISTRIBUTION
            </div>
            <div style={{ display: "flex", justifyContent: "space-around", alignItems: "flex-end", height: "100px", marginBottom: "12px" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}>X</div>
                <div style={{ 
                  width: "30px", 
                  height: `${(latestRef.current.energyRatio[0] || 0) * 100}px`,
                  backgroundColor: "#f44336",
                  borderRadius: "4px 4px 0 0"
                }}></div>
                <div style={{ fontSize: "11px", color: "#999", marginTop: "4px" }}>
                  {(latestRef.current.energyRatio[0] * 100 || 0).toFixed(0)}%
                </div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}>Y</div>
                <div style={{ 
                  width: "30px", 
                  height: `${(latestRef.current.energyRatio[1] || 0) * 100}px`,
                  backgroundColor: "#FF9800",
                  borderRadius: "4px 4px 0 0"
                }}></div>
                <div style={{ fontSize: "11px", color: "#999", marginTop: "4px" }}>
                  {(latestRef.current.energyRatio[1] * 100 || 0).toFixed(0)}%
                </div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}>Z</div>
                <div style={{ 
                  width: "30px", 
                  height: `${(latestRef.current.energyRatio[2] || 0) * 100}px`,
                  backgroundColor: "#4CAF50",
                  borderRadius: "4px 4px 0 0"
                }}></div>
                <div style={{ fontSize: "11px", color: "#999", marginTop: "4px" }}>
                  {(latestRef.current.energyRatio[2] * 100 || 0).toFixed(0)}%
                </div>
              </div>
            </div>
          </div>
        </div>
        
        {/* How It Works */}
        <div
          style={{
            backgroundColor: "#e3f2fd",
            borderRadius: "10px",
            padding: "16px",
            marginBottom: "24px",
          }}
        >
          <div style={{ fontSize: "16px", color: "#1565c0", marginBottom: "8px", fontWeight: "600" }}>
            🎯 HOW IT WORKS:
          </div>
          <div style={{ fontSize: "14px", color: "#0d47a1", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
            <div>• <strong>Z-Axis Locked:</strong> Always monitors Z-axis for proper curls</div>
            <div>• <strong>Counts All Reps:</strong> Detects movement on any axis</div>
            <div>• <strong>Z-Axis = GOOD:</strong> Proper vertical curl motion</div>
            <div>• <strong>X/Y-Axis = BAD:</strong> Sideways/wrong direction motion</div>
            <div>• <strong>Accuracy:</strong> Good reps ÷ Total reps × 100%</div>
          </div>
        </div>
        
        {/* Services and Characteristics */}
        {services.length > 0 && (
          <div style={{ marginBottom: "32px" }}>
            <h3 style={{ color: "#2c3e50", marginBottom: "16px" }}>
              📡 Available Services ({services.length})
            </h3>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "10px",
                marginBottom: "24px",
              }}
            >
              {services.map((service) => (
                <button
                  key={service.uuid}
                  onClick={() => selectService(service)}
                  style={{
                    padding: "10px 16px",
                    backgroundColor: "#e3f2fd",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: "500",
                    cursor: "pointer",
                    color: "#1565c0",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: "200px",
                  }}
                  title={service.uuid}
                >
                  {service.uuid.substring(0, 8)}...
                </button>
              ))}
            </div>
          </div>
        )}
        
        {characteristics.length > 0 && (
          <div style={{ marginBottom: "32px" }}>
            <h3 style={{ color: "#2c3e50", marginBottom: "16px" }}>
              🔔 Notify Characteristics ({characteristics.length})
            </h3>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "10px",
              }}
            >
              {characteristics.map((characteristic) => (
                <button
                  key={characteristic.uuid}
                  onClick={() => subscribeCharacteristic(characteristic)}
                  style={{
                    padding: "10px 16px",
                    backgroundColor: "#f3e5f5",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: "500",
                    cursor: "pointer",
                    color: "#7b1fa2",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: "200px",
                  }}
                  title={`${characteristic.uuid}\nProperties: ${Object.keys(
                    characteristic.properties,
                  )
                    .filter((k) => characteristic.properties[k])
                    .join(", ")}`}
                >
                  {characteristic.uuid.substring(0, 8)}...
                </button>
              ))}
            </div>
          </div>
        )}
        
        {/* Graph */}
        {graphData.length > 0 && (
          <div
            style={{
              backgroundColor: "white",
              padding: "20px",
              borderRadius: "12px",
              boxShadow: "0 2px 10px rgba(0,0,0,0.05)",
              marginBottom: "24px",
            }}
          >
            <div style={{ width: "100%", height: "350px" }}>
              <ResponsiveContainer>
                <LineChart data={graphData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                  <XAxis
                    dataKey="time"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(unixTime) => {
                      const date = new Date(unixTime);
                      return `${date.getSeconds().toString().padStart(2, "0")}.${Math.floor(date.getMilliseconds()/100)}`;
                    }}
                    stroke="#666"
                  />
                  <YAxis stroke="#666" />
                  <Tooltip
                    labelFormatter={(label) =>
                      new Date(label).toLocaleTimeString()
                    }
                    formatter={(value, name) => [value.toFixed(3), name]}
                    contentStyle={{
                      backgroundColor: "white",
                      border: "1px solid #ccc",
                      borderRadius: "8px",
                    }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="zSignal"
                    stroke="#4CAF50"
                    strokeWidth={3}
                    dot={false}
                    isAnimationActive={false}
                    name="Z-Axis (Good)"
                  />
                  <Line
                    type="monotone"
                    dataKey="xSignal"
                    stroke="#f44336"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                    name="X-Axis (Bad)"
                  />
                  <Line
                    type="monotone"
                    dataKey="ySignal"
                    stroke="#FF9800"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                    name="Y-Axis (Bad)"
                  />
                  {repMarks.map((mark, index) => (
                    <ReferenceLine
                      key={index}
                      x={mark.time}
                      stroke={mark.type === 'GOOD' ? "#4CAF50" : "#f44336"}
                      strokeWidth={2}
                      strokeDasharray="3 3"
                      label={{
                        value: mark.type === 'GOOD' ? `✅ Z` : `❌ ${mark.axis}`,
                        position: "top",
                        fill: mark.type === 'GOOD' ? "#4CAF50" : "#f44336",
                        fontSize: 10,
                      }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
        
        {/* Status Bar */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingTop: "20px",
            borderTop: "1px solid #eee",
            fontSize: "14px",
            color: "#666",
            flexWrap: "wrap",
            gap: "10px",
          }}
        >
          <div>
            <strong>Status:</strong> {connected ? "Connected" : "Disconnected"}
            {csvMode && " | CSV Mode"}
            {connected && " | "}
            {connected && `Data Points: ${graphData.length}`}
          </div>
          <div>
            <strong>Current Axis:</strong> {latestRef.current.dominantAxis || "Z"}
            {latestRef.current.repDetected && " | REP DETECTED!"}
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <div
                style={{
                  width: "12px",
                  height: "12px",
                  backgroundColor: "#4CAF50",
                  borderRadius: "2px",
                }}
              ></div>
              <span>Z-Axis (Good)</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <div
                style={{
                  width: "12px",
                  height: "12px",
                  backgroundColor: "#f44336",
                  borderRadius: "2px",
                }}
              ></div>
              <span>X-Axis (Bad)</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <div
                style={{
                  width: "12px",
                  height: "12px",
                  backgroundColor: "#FF9800",
                  borderRadius: "2px",
                }}
              ></div>
              <span>Y-Axis (Bad)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
