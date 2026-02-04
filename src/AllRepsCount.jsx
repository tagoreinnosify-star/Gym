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
  BarChart,
  Bar,
  Cell,
} from "recharts";
import * as XLSX from "xlsx";

/* ================= CONFIG ================= */
const FS = 10; // Sampling frequency from your data (100ms intervals)
const LP_ALPHA = 0.3; // Adjusted low-pass filter coefficient
const ACC_ALPHA = 0.1; // Gravity estimation smoothing

// Optimized thresholds based on your CSV data analysis
const EXERCISE_THRESHOLDS = {
  NORMAL_CURL: {
    MIN_GYRO: 0.8,
    MIN_REP_GYRO: 1.5,
    ENERGY_THRESH: 2.0,
    MIN_REP_MS: 800,
    MIN_VERT_ACC: 0.2,
    MAX_VERT_ACC: 1.5,
    GYRO_PEAK_THRESH: 0.4,
  },
  HAMMER_CURL: {
    MIN_GYRO: 0.8,
    MIN_REP_GYRO: 1.5,
    ENERGY_THRESH: 2.0,
    MIN_REP_MS: 800,
    MIN_VERT_ACC: 0.2,
    MAX_VERT_ACC: 1.5,
    GYRO_PEAK_THRESH: 0.4,
  },
  CROSSBODY_HAMMER: {
    MIN_GYRO: 1.0,
    MIN_REP_GYRO: 2.0,
    ENERGY_THRESH: 3.0,
    MIN_REP_MS: 1000,
    MIN_VERT_ACC: 0.3,
    MAX_VERT_ACC: 2.0,
    GYRO_PEAK_THRESH: 0.6,
    MIN_GW_RATIO: 1.5, // Cross-body movement has higher gW
  },
  ARNOLD_PRESS: {
    MIN_GYRO: 1.2,
    MIN_REP_GYRO: 2.5,
    ENERGY_THRESH: 4.0,
    MIN_REP_MS: 1200,
    MIN_VERT_ACC: 0.4,
    MAX_VERT_ACC: 2.5,
    GYRO_PEAK_THRESH: 0.8,
    MIN_GW_RATIO: 2.0, // Arnold press has significant rotation
  },
  GOBLET_SQUAT: {
    MIN_GYRO: 0.6,
    MIN_REP_GYRO: 1.0,
    ENERGY_THRESH: 5.0,
    MIN_REP_MS: 1500,
    MIN_VERT_ACC: 0.5,
    MAX_VERT_ACC: 3.0,
    GYRO_PEAK_THRESH: 0.3,
    MIN_AZ_AMPLITUDE: 2.0, // Squats have large vertical acceleration changes
  },
};

/* ================= VECTOR UTILS ================= */
const mag = (v) => Math.hypot(v[0], v[1], v[2]) || 1;
const normalize = (v) => v.map((x) => x / mag(v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/* ================= PEAK DETECTOR ================= */
function createPeakDetector() {
  let window = [];
  let peaks = [];

  return {
    detect: (value, timestamp) => {
      window.push({ value, timestamp });

      // Keep only last 5 samples for peak detection
      if (window.length > 5) {
        window.shift();
      }

      if (window.length < 3) return null;

      const midIndex = Math.floor(window.length / 2);
      const midValue = window[midIndex].value;
      const isPeak = window.every(
        (point, idx) => idx === midIndex || point.value <= midValue,
      );

      if (isPeak) {
        peaks.push({ value: midValue, timestamp: window[midIndex].timestamp });
        // Keep only recent peaks
        if (peaks.length > 10) peaks.shift();
        return { value: midValue, timestamp: window[midIndex].timestamp };
      }

      return null;
    },

    getRecentPeaks: () => [...peaks],

    reset: () => {
      window = [];
      peaks = [];
    },
  };
}

/* ================= EXERCISE DETECTOR ================= */
function createExerciseDetector() {
  // Rep counts for each exercise
  let repCounts = {
    NORMAL_CURL: 0,
    HAMMER_CURL: 0,
    CROSSBODY_HAMMER: 0,
    ARNOLD_PRESS: 0,
    GOBLET_SQUAT: 0,
  };

  let accuracyStats = {
    NORMAL_CURL: { correct: 0, total: 0 },
    HAMMER_CURL: { correct: 0, total: 0 },
    CROSSBODY_HAMMER: { correct: 0, total: 0 },
    ARNOLD_PRESS: { correct: 0, total: 0 },
    GOBLET_SQUAT: { correct: 0, total: 0 },
  };

  let missedReps = 0;
  let currentExercise = null;
  let lastRepTime = 0;
  let lastExerciseChange = Date.now();

  // State tracking
  let state = "IDLE";
  let energy = 0;
  let lpFilter = { value: 0 };

  // Gravity vector and buffers
  let gVec = [0, 0, 9.81];
  let accBuffer = [0, 0, 9.81];
  const BUFFER_SIZE = 20;
  let gyroBuffer = [];
  let accMagnitudeBuffer = [];

  // Peak detector
  const peakDetector = createPeakDetector();

  // Exercise features
  let exerciseFeatures = {
    dominantAxis: null,
    gyroHistory: [],
    accHistory: [],
    peakHistory: [],
  };

  function resetForNewExercise() {
    state = "IDLE";
    energy = 0;
    lpFilter = { value: 0 };
    gyroBuffer = [];
    accMagnitudeBuffer = [];
    exerciseFeatures = {
      dominantAxis: null,
      gyroHistory: [],
      accHistory: [],
      peakHistory: [],
    };
    peakDetector.reset();
  }

  // Feature extraction
  function extractFeatures(gyro, acc) {
    // Update gravity vector (slow adaptation)
    for (let i = 0; i < 3; i++) {
      gVec[i] = (1 - ACC_ALPHA) * gVec[i] + ACC_ALPHA * acc[i];
    }

    // Normalize gravity vector
    const g = normalize(gVec);

    // Create coordinate frame aligned with gravity
    let u = cross(g, [1, 0, 0]);
    if (mag(u) < 0.1) u = cross(g, [0, 1, 0]);
    u = normalize(u);
    const v = cross(g, u);
    const w = g;

    // Project gyro onto axes
    const gU = dot(gyro, u);
    const gV = dot(gyro, v);
    const gW = dot(gyro, w);

    // Project acceleration onto axes
    const aU = dot(acc, u);
    const aV = dot(acc, v);
    const aW = dot(acc, w);

    // Calculate magnitudes
    const gyroMag = Math.hypot(gU, gV, gW);
    const accMag = Math.hypot(acc[0], acc[1], acc[2]);
    const verticalAcc = aW;

    // Update buffers
    gyroBuffer.push(gyroMag);
    accMagnitudeBuffer.push(accMag);

    if (gyroBuffer.length > BUFFER_SIZE) gyroBuffer.shift();
    if (accMagnitudeBuffer.length > BUFFER_SIZE) accMagnitudeBuffer.shift();

    // Calculate moving averages
    const avgGyro = gyroBuffer.reduce((a, b) => a + b, 0) / gyroBuffer.length;
    const avgAcc =
      accMagnitudeBuffer.reduce((a, b) => a + b, 0) / accMagnitudeBuffer.length;

    // Determine dominant axis
    const axisEnergies = [Math.abs(gU), Math.abs(gV), Math.abs(gW)];
    const maxEnergy = Math.max(...axisEnergies);
    const dominantAxis = axisEnergies.indexOf(maxEnergy);

    // Calculate ratios
    const gURatio = Math.abs(gU) / (gyroMag || 1);
    const gVRatio = Math.abs(gV) / (gyroMag || 1);
    const gWRatio = Math.abs(gW) / (gyroMag || 1);

    return {
      gU,
      gV,
      gW,
      aU,
      aV,
      aW,
      gyroMag,
      accMag,
      verticalAcc,
      avgGyro,
      avgAcc,
      dominantAxis,
      axisRatios: { gURatio, gVRatio, gWRatio },
      rawAcc: [...acc],
      rawGyro: [...gyro],
      timestamp: Date.now(),
    };
  }

  // Exercise classification
  function classifyExercise(features) {
    const { gyroMag, verticalAcc, axisRatios, rawAcc, avgGyro, accMag } =
      features;

    const { gURatio, gVRatio, gWRatio } = axisRatios;

    // Check for Goblet Squat (based on your CSV data)
    // Squats have large vertical acceleration and relatively low gyro
    if (Math.abs(verticalAcc) > 1.5 && gyroMag < 2.0 && accMag > 8.0) {
      return "GOBLET_SQUAT";
    }

    // Check for Arnold Press (significant rotation - high gW ratio)
    if (gWRatio > 0.6 && gyroMag > 1.5 && Math.abs(verticalAcc) > 0.5) {
      return "ARNOLD_PRESS";
    }

    // Check for Crossbody Hammer (high V-axis movement)
    if (gVRatio > 0.5 && gyroMag > 1.2 && gVRatio > gURatio * 1.2) {
      return "CROSSBODY_HAMMER";
    }

    // Check for Hammer Curl (more V-axis than U-axis)
    if (gVRatio > 0.4 && gVRatio > gURatio && gyroMag > 0.8) {
      return "HAMMER_CURL";
    }

    // Check for Normal Curl (more U-axis than V-axis)
    if (gURatio > 0.4 && gURatio > gVRatio && gyroMag > 0.8) {
      return "NORMAL_CURL";
    }

    // Default based on highest ratio
    if (gURatio > gVRatio && gURatio > gWRatio) {
      return "NORMAL_CURL";
    } else if (gVRatio > gURatio && gVRatio > gWRatio) {
      return "HAMMER_CURL";
    } else if (gWRatio > gURatio && gWRatio > gVRatio) {
      return "ARNOLD_PRESS";
    }

    return null;
  }

  // Rep detection logic
  function detectRep(features, timestamp, groundTruthExercise = null) {
    const { gyroMag, verticalAcc, axisRatios, avgGyro } = features;

    if (!currentExercise) return false;

    const thresholds = EXERCISE_THRESHOLDS[currentExercise];

    // Apply low-pass filter to gyro magnitude
    lpFilter.value = LP_ALPHA * gyroMag + (1 - LP_ALPHA) * lpFilter.value;
    const filteredGyro = lpFilter.value;

    // Detect peak in gyro magnitude
    const peak = peakDetector.detect(filteredGyro, timestamp);

    // Update energy accumulation
    energy += filteredGyro / FS;

    // Check if we're in a movement
    if (gyroMag > thresholds.MIN_GYRO) {
      if (state === "IDLE") {
        state = "MOVING";
        energy = 0;
      }
    } else if (gyroMag < thresholds.MIN_GYRO * 0.3 && state === "MOVING") {
      // Movement ended
      state = "IDLE";
    }

    // Rep detection conditions
    let repDetected = false;
    let detectedExerciseType = currentExercise;

    if (peak && state === "MOVING") {
      const timeSinceLastRep = timestamp - lastRepTime;
      const peakValue = peak.value;

      // Check if peak exceeds threshold and enough time has passed
      if (
        peakValue > thresholds.MIN_REP_GYRO &&
        timeSinceLastRep > thresholds.MIN_REP_MS
      ) {
        // Additional validation based on exercise type
        let isValidRep = false;

        switch (currentExercise) {
          case "GOBLET_SQUAT":
            // Squat: check for vertical acceleration pattern
            isValidRep = Math.abs(verticalAcc) > thresholds.MIN_AZ_AMPLITUDE;
            break;

          case "ARNOLD_PRESS":
            // Arnold press: check for rotation component
            isValidRep = axisRatios.gWRatio > 0.5;
            detectedExerciseType = "ARNOLD_PRESS";
            break;

          case "CROSSBODY_HAMMER":
            // Crossbody: check for V-axis dominance
            isValidRep = axisRatios.gVRatio > axisRatios.gURatio * 1.2;
            detectedExerciseType = "CROSSBODY_HAMMER";
            break;

          case "HAMMER_CURL":
            // Hammer curl: V-axis should dominate
            isValidRep = axisRatios.gVRatio > axisRatios.gURatio;
            detectedExerciseType = "HAMMER_CURL";
            break;

          case "NORMAL_CURL":
            // Normal curl: U-axis should dominate
            isValidRep = axisRatios.gURatio > axisRatios.gVRatio;
            detectedExerciseType = "NORMAL_CURL";
            break;

          default:
            isValidRep = energy > thresholds.ENERGY_THRESH;
        }

        if (isValidRep) {
          repDetected = true;
          lastRepTime = timestamp;

          // Update rep count for the detected exercise
          if (repCounts[detectedExerciseType] !== undefined) {
            repCounts[detectedExerciseType]++;
          }

          // Update accuracy stats if ground truth is available
          if (groundTruthExercise && accuracyStats[groundTruthExercise]) {
            accuracyStats[groundTruthExercise].total++;
            if (detectedExerciseType === groundTruthExercise) {
              accuracyStats[groundTruthExercise].correct++;
            }
          }

          // Reset for next rep
          state = "IDLE";
          energy = 0;
        }
      }
    }

    // Check for missed reps (if we've been moving but no rep detected)
    if (state === "MOVING" && timestamp - lastRepTime > 3000) {
      if (energy > thresholds.ENERGY_THRESH * 0.5) {
        missedReps++;
        state = "IDLE";
        energy = 0;
      }
    }

    return {
      repDetected,
      detectedExerciseType,
      isCorrect: groundTruthExercise
        ? detectedExerciseType === groundTruthExercise
        : null,
    };
  }

  function update(gyro, acc, groundTruthExercise = null) {
    const timestamp = Date.now();

    // Extract features
    const features = extractFeatures(gyro, acc);

    // Exercise classification (if not set or it's been a while)
    if (!currentExercise || timestamp - lastExerciseChange > 5000) {
      const detectedExercise = classifyExercise(features);
      if (detectedExercise && detectedExercise !== currentExercise) {
        currentExercise = detectedExercise;
        lastExerciseChange = timestamp;
        resetForNewExercise();
        console.log(`Exercise changed to: ${currentExercise}`);
      }
    }

    // If still no exercise, try to detect
    if (!currentExercise) {
      const detectedExercise = classifyExercise(features);
      if (detectedExercise) {
        currentExercise = detectedExercise;
        lastExerciseChange = timestamp;
        resetForNewExercise();
      }
    }

    // Detect rep
    const repResult = detectRep(features, timestamp, groundTruthExercise);

    return {
      value: features.gyroMag,
      repDetected: repResult.repDetected,
      repType: repResult.detectedExerciseType,
      exercise: currentExercise,
      repCounts: { ...repCounts },
      accuracyStats: { ...accuracyStats },
      missedReps,
      state,
      energy,
      gU: features.gU,
      gV: features.gV,
      gW: features.gW,
      features,
      timestamp,
      isCorrectRep: repResult.isCorrect,
    };
  }

  function reset() {
    repCounts = {
      NORMAL_CURL: 0,
      HAMMER_CURL: 0,
      CROSSBODY_HAMMER: 0,
      ARNOLD_PRESS: 0,
      GOBLET_SQUAT: 0,
    };
    accuracyStats = {
      NORMAL_CURL: { correct: 0, total: 0 },
      HAMMER_CURL: { correct: 0, total: 0 },
      CROSSBODY_HAMMER: { correct: 0, total: 0 },
      ARNOLD_PRESS: { correct: 0, total: 0 },
      GOBLET_SQUAT: { correct: 0, total: 0 },
    };
    missedReps = 0;
    currentExercise = null;
    lastRepTime = 0;
    lastExerciseChange = Date.now();
    resetForNewExercise();
  }

  return { update, reset, getExercise: () => currentExercise };
}

const log = [];

/* ================= CSV PROCESSOR ================= */
function createCSVProcessor() {
  let csvData = [];
  let currentIndex = 0;
  let detector = null;

  function parseCSV(csvText) {
    const lines = csvText.split("\n");
    const headers = lines[0].split(",");

    csvData = lines
      .slice(1)
      .filter((line) => line.trim())
      .map((line) => {
        const values = line.split(",");
        const obj = {};
        headers.forEach((header, index) => {
          const value = values[index] ? values[index].trim() : "";
          if (header === "phase" || header === "exercise") {
            obj[header] = value;
          } else if (header === "rep") {
            obj[header] = value ? parseInt(value) : null;
          } else {
            obj[header] = value ? parseFloat(value) : 0;
          }
        });
        return obj;
      });

    currentIndex = 0;
    detector = createExerciseDetector();
  }

  function getNextSample() {
    if (currentIndex >= csvData.length) return null;

    const sample = csvData[currentIndex];
    currentIndex++;

    // Convert to arrays
    const acc = [sample.ax, sample.ay, sample.az];
    const gyro = [sample.gx, sample.gy, sample.gz];

    // Process through detector
    const result = detector.update(gyro, acc, sample.exercise);

    // Log for comparison
    log.push({
      ...sample,
      detectedRep: result.repDetected,
      detectedExercise: result.repType,
      timestamp: Date.now(),
      isCorrect: result.isCorrectRep,
    });

    return {
      ...result,
      groundTruth: {
        exercise: sample.exercise,
        phase: sample.phase,
        rep: sample.rep,
      },
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
  const detectorRef = useRef(createExerciseDetector());
  const csvProcessorRef = useRef(createCSVProcessor());
  const deviceRef = useRef(null);
  const charRef = useRef(null);
  const rafRef = useRef(null);
  const notificationHandlerRef = useRef(null);
  const startedRef = useRef(false);

  // Latest sensor data and detection results
  const latestRef = useRef({
    repCounts: {
      NORMAL_CURL: 0,
      HAMMER_CURL: 0,
      CROSSBODY_HAMMER: 0,
      ARNOLD_PRESS: 0,
      GOBLET_SQUAT: 0,
    },
    accuracyStats: {
      NORMAL_CURL: { correct: 0, total: 0 },
      HAMMER_CURL: { correct: 0, total: 0 },
      CROSSBODY_HAMMER: { correct: 0, total: 0 },
      ARNOLD_PRESS: { correct: 0, total: 0 },
      GOBLET_SQUAT: { correct: 0, total: 0 },
    },
    missedReps: 0,
    value: 0,
    repDetected: false,
    repType: null,
    exercise: null,
    state: "IDLE",
    energy: 0,
    gU: 0,
    gV: 0,
    gW: 0,
    lastUpdate: Date.now(),
  });

  // State
  const [services, setServices] = useState([]);
  const [characteristics, setCharacteristics] = useState([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [dataRate, setDataRate] = useState(0);
  const [repCounts, setRepCounts] = useState({
    NORMAL_CURL: 0,
    HAMMER_CURL: 0,
    CROSSBODY_HAMMER: 0,
    ARNOLD_PRESS: 0,
    GOBLET_SQUAT: 0,
  });
  const [accuracyStats, setAccuracyStats] = useState({
    NORMAL_CURL: { correct: 0, total: 0 },
    HAMMER_CURL: { correct: 0, total: 0 },
    CROSSBODY_HAMMER: { correct: 0, total: 0 },
    ARNOLD_PRESS: { correct: 0, total: 0 },
    GOBLET_SQUAT: { correct: 0, total: 0 },
  });
  const [missedReps, setMissedReps] = useState(0);
  const [currentExercise, setCurrentExercise] = useState(null);
  const [graphData, setGraphData] = useState([]);
  const [exerciseGraphs, setExerciseGraphs] = useState({
    NORMAL_CURL: [],
    HAMMER_CURL: [],
    CROSSBODY_HAMMER: [],
    ARNOLD_PRESS: [],
    GOBLET_SQUAT: [],
  });
  const [repMarks, setRepMarks] = useState([]);
  const [lastDataTime, setLastDataTime] = useState(null);
  const [dataCount, setDataCount] = useState(0);
  const [showExerciseSelect, setShowExerciseSelect] = useState(false);
  const [manualExercise, setManualExercise] = useState(null);
  const [csvMode, setCsvMode] = useState(false);
  const [csvFile, setCsvFile] = useState(null);
  const [processingCSV, setProcessingCSV] = useState(false);
  const [selectedGraph, setSelectedGraph] = useState("ALL");

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
    setDataCount((prev) => prev + 1);

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
        optionalServices: ["12345678-1234-5678-1234-56789abcdef0"],
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
            ax,
            ay,
            az,
            gx,
            gy,
            gz,
            timestamp: Date.now(),
          });

          dataRateRef.current.count++;
          const now = Date.now();
          if (now - dataRateRef.current.lastCalc > 1000) {
            setDataRate(dataRateRef.current.count);
            dataRateRef.current = { count: 0, lastCalc: now };
          }

          const result = detectorRef.current.update([gx, gy, gz], [ax, ay, az]);

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

              const result = detectorRef.current.update(
                [gx, gy, gz],
                [ax, ay, az],
              );
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
    const ws1 = XLSX.utils.json_to_sheet(
      log.map((entry) => ({
        timestamp: new Date(entry.timestamp).toISOString(),
        ax: entry.ax?.toFixed(4),
        ay: entry.ay?.toFixed(4),
        az: entry.az?.toFixed(4),
        gx: entry.gx?.toFixed(4),
        gy: entry.gy?.toFixed(4),
        gz: entry.gz?.toFixed(4),
        detectedExercise: entry.detectedExercise,
        groundTruth: entry.exercise,
        isCorrect: entry.isCorrect ? "YES" : "NO",
      })),
    );

    // Add rep summary
    const summary = [
      ["Exercise Summary"],
      ["Exercise", "Reps", "Accuracy"],
      [
        "Normal Curls",
        repCounts.NORMAL_CURL,
        accuracyStats.NORMAL_CURL.total > 0
          ? `${((accuracyStats.NORMAL_CURL.correct / accuracyStats.NORMAL_CURL.total) * 100).toFixed(1)}%`
          : "N/A",
      ],
      [
        "Hammer Curls",
        repCounts.HAMMER_CURL,
        accuracyStats.HAMMER_CURL.total > 0
          ? `${((accuracyStats.HAMMER_CURL.correct / accuracyStats.HAMMER_CURL.total) * 100).toFixed(1)}%`
          : "N/A",
      ],
      [
        "Crossbody Hammer",
        repCounts.CROSSBODY_HAMMER,
        accuracyStats.CROSSBODY_HAMMER.total > 0
          ? `${((accuracyStats.CROSSBODY_HAMMER.correct / accuracyStats.CROSSBODY_HAMMER.total) * 100).toFixed(1)}%`
          : "N/A",
      ],
      [
        "Arnold Press",
        repCounts.ARNOLD_PRESS,
        accuracyStats.ARNOLD_PRESS.total > 0
          ? `${((accuracyStats.ARNOLD_PRESS.correct / accuracyStats.ARNOLD_PRESS.total) * 100).toFixed(1)}%`
          : "N/A",
      ],
      [
        "Goblet Squat",
        repCounts.GOBLET_SQUAT,
        accuracyStats.GOBLET_SQUAT.total > 0
          ? `${((accuracyStats.GOBLET_SQUAT.correct / accuracyStats.GOBLET_SQUAT.total) * 100).toFixed(1)}%`
          : "N/A",
      ],
      ["Total Reps", Object.values(repCounts).reduce((a, b) => a + b, 0), ""],
      ["Missed Reps", missedReps, ""],
      ["Current Exercise", currentExercise || "Unknown", ""],
    ];

    const ws2 = XLSX.utils.aoa_to_sheet(summary);

    XLSX.utils.book_append_sheet(wb, ws1, "Sensor_Data");
    XLSX.utils.book_append_sheet(wb, ws2, "Summary");
    XLSX.writeFile(wb, `Gym_Workout_Data_${Date.now()}.xlsx`);
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
      repCounts: {
        NORMAL_CURL: 0,
        HAMMER_CURL: 0,
        CROSSBODY_HAMMER: 0,
        ARNOLD_PRESS: 0,
        GOBLET_SQUAT: 0,
      },
      accuracyStats: {
        NORMAL_CURL: { correct: 0, total: 0 },
        HAMMER_CURL: { correct: 0, total: 0 },
        CROSSBODY_HAMMER: { correct: 0, total: 0 },
        ARNOLD_PRESS: { correct: 0, total: 0 },
        GOBLET_SQUAT: { correct: 0, total: 0 },
      },
      missedReps: 0,
      value: 0,
      repDetected: false,
      repType: null,
      exercise: null,
      state: "IDLE",
      energy: 0,
      gU: 0,
      gV: 0,
      gW: 0,
      lastUpdate: Date.now(),
    };
    startedRef.current = false;
    setRepCounts({
      NORMAL_CURL: 0,
      HAMMER_CURL: 0,
      CROSSBODY_HAMMER: 0,
      ARNOLD_PRESS: 0,
      GOBLET_SQUAT: 0,
    });
    setAccuracyStats({
      NORMAL_CURL: { correct: 0, total: 0 },
      HAMMER_CURL: { correct: 0, total: 0 },
      CROSSBODY_HAMMER: { correct: 0, total: 0 },
      ARNOLD_PRESS: { correct: 0, total: 0 },
      GOBLET_SQUAT: { correct: 0, total: 0 },
    });
    setMissedReps(0);
    setCurrentExercise(null);
    setGraphData([]);
    setExerciseGraphs({
      NORMAL_CURL: [],
      HAMMER_CURL: [],
      CROSSBODY_HAMMER: [],
      ARNOLD_PRESS: [],
      GOBLET_SQUAT: [],
    });
    setRepMarks([]);
    setDataRate(0);
    dataRateRef.current = { count: 0, lastCalc: Date.now() };
    setManualExercise(null);
    setShowExerciseSelect(false);
    setCsvMode(false);
    setProcessingCSV(false);
    setSelectedGraph("ALL");
  }, []);

  const setExerciseManually = (exercise) => {
    setManualExercise(exercise);
    setShowExerciseSelect(false);
  };

  /* ================= UI UPDATE LOOP ================= */
  useEffect(() => {
    let lastGraphUpdate = 0;
    const GRAPH_UPDATE_MS = 100; // Match CSV interval

    const updateLoop = () => {
      const now = Date.now();
      const data = latestRef.current;

      // Update counts
      setRepCounts(data.repCounts);
      setAccuracyStats(data.accuracyStats);
      setMissedReps(data.missedReps);
      setCurrentExercise(manualExercise || data.exercise);

      if (!startedRef.current) {
        rafRef.current = requestAnimationFrame(updateLoop);
        return;
      }

      if (now - lastGraphUpdate >= GRAPH_UPDATE_MS) {
        lastGraphUpdate = now;

        setGraphData((prev) => {
          const newPoint = {
            time: now,
            value: data.value,
            gU: data.gU || 0,
            gV: data.gV || 0,
            gW: data.gW || 0,
            energy: data.energy || 0,
            exercise: data.exercise,
          };

          const newData = [...prev.slice(-200), newPoint];
          return newData;
        });

        // Update exercise-specific graphs
        if (data.exercise && exerciseGraphs[data.exercise]) {
          setExerciseGraphs((prev) => {
            const newPoint = {
              time: now,
              value: data.value,
              gU: data.gU || 0,
              gV: data.gV || 0,
              gW: data.gW || 0,
              exercise: data.exercise,
            };

            const updatedGraphs = { ...prev };
            updatedGraphs[data.exercise] = [
              ...prev[data.exercise].slice(-100),
              newPoint,
            ];
            return updatedGraphs;
          });
        }

        if (data.repDetected && data.repType) {
          setRepMarks((prev) => {
            const newMark = {
              time: now,
              value: data.value,
              type: data.repType,
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
  }, [manualExercise, exerciseGraphs]);

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

  // Calculate total reps
  const totalReps = Object.values(repCounts).reduce((a, b) => a + b, 0);

  // Exercise display names
  const exerciseNames = {
    NORMAL_CURL: "Normal Curl",
    HAMMER_CURL: "Hammer Curl",
    CROSSBODY_HAMMER: "Crossbody Hammer",
    ARNOLD_PRESS: "Arnold Press",
    GOBLET_SQUAT: "Goblet Squat",
  };

  // Exercise colors
  const exerciseColors = {
    NORMAL_CURL: "#4caf50",
    HAMMER_CURL: "#ff9800",
    CROSSBODY_HAMMER: "#2196f3",
    ARNOLD_PRESS: "#9c27b0",
    GOBLET_SQUAT: "#009688",
  };

  // Calculate accuracy for each exercise
  const getAccuracy = (exercise) => {
    const stats = accuracyStats[exercise];
    if (stats.total === 0) return "N/A";
    return `${((stats.correct / stats.total) * 100).toFixed(1)}%`;
  };

  // Prepare data for bar chart
  const barChartData = Object.keys(exerciseNames).map((exercise) => ({
    name: exerciseNames[exercise],
    count: repCounts[exercise],
    accuracy: getAccuracy(exercise),
    color: exerciseColors[exercise],
  }));

  // Get current graph data based on selection
  const getCurrentGraphData = () => {
    if (selectedGraph === "ALL") {
      return graphData;
    }
    return exerciseGraphs[selectedGraph] || [];
  };

  /* ================= RENDER ================= */
  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display:"flex",
        flexDirection:"column",
        justifyContent:"center"
      }}
    >
      <div
        style={{
          padding: "20px",
          width: "99%",
          fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
          backgroundColor: "#f5f5f5",
          height: "100%",
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
            <span>🏋️‍♂️ Smart Dumbbell Rep Counter</span>
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
                  position: "relative",
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
                  cursor:
                    connected || isScanning || csvMode
                      ? "not-allowed"
                      : "pointer",
                  minWidth: "150px",
                  opacity: connected || isScanning || csvMode ? 0.8 : 1,
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
                style={{
                  display: "none",
                }}
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
                🔄 Reset
              </button>

              <button
                onClick={() => setShowExerciseSelect((s) => !s)}
                style={{
                  padding: "12px 16px",
                  backgroundColor: showExerciseSelect ? "#455a64" : "#607d8b",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  fontSize: "16px",
                  fontWeight: "500",
                  cursor: "pointer",
                }}
              >
                {showExerciseSelect ? "Close Exercise" : "Select Exercise"}
              </button>

              {showExerciseSelect && (
                <div
                  style={{
                    position: "absolute",
                    backgroundColor: "white",
                    border: "1px solid #ddd",
                    borderRadius: "8px",
                    padding: "10px",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                    zIndex: 1000,
                    top:50,
                    left:"70%"
                  }}
                >
                  {Object.keys(exerciseNames).map((exercise) => (
                    <div
                      key={exercise}
                      onClick={() => setExerciseManually(exercise)}
                      style={{
                        padding: "8px 12px",
                        cursor: "pointer",
                        borderRadius: "4px",
                        backgroundColor:
                          manualExercise === exercise ? "#e3f2fd" : "white",
                        color: manualExercise === exercise ? "#1565c0" : "#333",
                        marginBottom: "4px",
                      }}
                    >
                      {exerciseNames[exercise]}
                    </div>
                  ))}
                  <div
                    onClick={() => setExerciseManually(null)}
                    style={{
                      padding: "8px 12px",
                      cursor: "pointer",
                      borderRadius: "4px",
                      backgroundColor:
                        manualExercise === null ? "#e3f2fd" : "white",
                      color: manualExercise === null ? "#1565c0" : "#333",
                    }}
                  >
                    Auto-detect
                  </div>
                </div>
              )}
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

              {lastDataTime && (
                <div
                  style={{
                    padding: "8px 16px",
                    backgroundColor: "#e3f2fd",
                    borderRadius: "8px",
                    fontSize: "14px",
                    color: "#1565c0",
                  }}
                >
                  ⏱️ Last:{" "}
                  {new Date(lastDataTime).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Current Exercise Display */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "24px",
              padding: "16px",
              backgroundColor: "#e3f2fd",
              borderRadius: "10px",
            }}
          >
            <div>
              <div style={{ fontSize: "14px", color: "#1565c0" }}>
                CURRENT EXERCISE
              </div>
              <div
                style={{
                  fontSize: "24px",
                  fontWeight: "600",
                  color: "#0d47a1",
                }}
              >
                {currentExercise
                  ? exerciseNames[currentExercise]
                  : "Auto-detecting..."}
              </div>
              {manualExercise && (
                <div
                  style={{ fontSize: "12px", color: "#666", marginTop: "4px" }}
                >
                  Manually set
                </div>
              )}
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "14px", color: "#1565c0" }}>
                TOTAL REPS
              </div>
              <div
                style={{
                  fontSize: "24px",
                  fontWeight: "600",
                  color: "#0d47a1",
                }}
              >
                {totalReps}
              </div>
              <div
                style={{ fontSize: "12px", color: "#666", marginTop: "4px" }}
              >
                Data points: {dataCount}
              </div>
            </div>
          </div>

          {/* Rep Counters Grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
              gap: "16px",
              marginBottom: "32px",
            }}
          >
            {Object.keys(exerciseNames).map((exercise) => {
              const count = repCounts[exercise];
              const accuracy = getAccuracy(exercise);
              const isCurrent = currentExercise === exercise;

              return (
                <div
                  key={exercise}
                  style={{
                    backgroundColor: isCurrent
                      ? exerciseColors[exercise] + "20"
                      : "#f8f9fa",
                    border: `2px solid ${isCurrent ? exerciseColors[exercise] : "#e0e0e0"}`,
                    borderRadius: "10px",
                    padding: "16px",
                    textAlign: "center",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                    transition: "all 0.3s ease",
                  }}
                >
                  <div
                    style={{
                      fontSize: "14px",
                      color: exerciseColors[exercise],
                      marginBottom: "8px",
                      fontWeight: "600",
                    }}
                  >
                    {exerciseNames[exercise]}
                    {isCurrent && " (Current)"}
                  </div>
                  <div
                    style={{
                      fontSize: "32px",
                      fontWeight: "700",
                      color: exerciseColors[exercise],
                    }}
                  >
                    {count}
                  </div>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#666",
                      marginTop: "4px",
                      backgroundColor: "#f0f0f0",
                      padding: "4px 8px",
                      borderRadius: "4px",
                      display: "inline-block",
                    }}
                  >
                    Accuracy: {accuracy}
                  </div>
                </div>
              );
            })}

            {/* Missed Reps */}
            <div
              style={{
                backgroundColor: "#ffebee",
                borderRadius: "10px",
                padding: "16px",
                textAlign: "center",
                boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
              }}
            >
              <div
                style={{
                  fontSize: "14px",
                  color: "#c62828",
                  marginBottom: "8px",
                  fontWeight: "600",
                }}
              >
                MISSED REPS
              </div>
              <div
                style={{
                  fontSize: "32px",
                  fontWeight: "700",
                  color: "#f44336",
                }}
              >
                {missedReps}
              </div>
            </div>
          </div>

          {/* Bar Chart */}
          <div
            style={{
              backgroundColor: "white",
              padding: "20px",
              borderRadius: "12px",
              boxShadow: "0 2px 10px rgba(0,0,0,0.05)",
              marginBottom: "24px",
            }}
          >
            <h3 style={{ margin: "0 0 20px 0", color: "#2c3e50" }}>
              📊 Reps Distribution
            </h3>
            <div style={{ width: "100%", height: "300px" }}>
              <ResponsiveContainer>
                <BarChart data={barChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                  <XAxis dataKey="name" stroke="#666" />
                  <YAxis stroke="#666" />
                  <Tooltip
                    formatter={(value, name) => {
                      if (name === "count") return [value, "Reps"];
                      return [value, "Accuracy"];
                    }}
                    contentStyle={{
                      backgroundColor: "white",
                      border: "1px solid #ccc",
                      borderRadius: "8px",
                    }}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {barChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Graph Selection */}
          <div style={{ marginBottom: "16px" }}>
            <div
              style={{
                display: "flex",
                gap: "10px",
                flexWrap: "wrap",
                marginBottom: "16px",
              }}
            >
              <button
                onClick={() => setSelectedGraph("ALL")}
                style={{
                  padding: "8px 16px",
                  backgroundColor:
                    selectedGraph === "ALL" ? "#2196F3" : "#e0e0e0",
                  color: selectedGraph === "ALL" ? "white" : "#333",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "14px",
                  fontWeight: "500",
                  cursor: "pointer",
                }}
              >
                All Exercises
              </button>
              {Object.keys(exerciseNames).map((exercise) => (
                <button
                  key={exercise}
                  onClick={() => setSelectedGraph(exercise)}
                  style={{
                    padding: "8px 16px",
                    backgroundColor:
                      selectedGraph === exercise
                        ? exerciseColors[exercise]
                        : "#e0e0e0",
                    color: selectedGraph === exercise ? "white" : "#333",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "500",
                    cursor: "pointer",
                  }}
                >
                  {exerciseNames[exercise]}
                </button>
              ))}
            </div>
          </div>

          {/* Graph */}
          {getCurrentGraphData().length > 0 && (
            <div
              style={{
                backgroundColor: "white",
                padding: "20px",
                borderRadius: "12px",
                boxShadow: "0 2px 10px rgba(0,0,0,0.05)",
                marginBottom: "24px",
              }}
            >
              <h3 style={{ margin: "0 0 20px 0", color: "#2c3e50" }}>
                📈{" "}
                {selectedGraph === "ALL"
                  ? "All Exercises"
                  : exerciseNames[selectedGraph]}{" "}
                - Gyro Data
              </h3>
              <div style={{ width: "100%", height: "300px" }}>
                <ResponsiveContainer>
                  <LineChart data={getCurrentGraphData()}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                    <XAxis
                      dataKey="time"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(unixTime) => {
                        const date = new Date(unixTime);
                        return `${date.getSeconds().toString().padStart(2, "0")}.${Math.floor(date.getMilliseconds() / 100)}`;
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
                      dataKey="value"
                      stroke="#8884d8"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      name="Gyro Magnitude"
                    />
                    <Line
                      type="monotone"
                      dataKey="gU"
                      stroke="#82ca9d"
                      strokeWidth={1}
                      dot={false}
                      isAnimationActive={false}
                      name="U Axis"
                    />
                    <Line
                      type="monotone"
                      dataKey="gV"
                      stroke="#ffc658"
                      strokeWidth={1}
                      dot={false}
                      isAnimationActive={false}
                      name="V Axis"
                    />
                    <Line
                      type="monotone"
                      dataKey="gW"
                      stroke="#ff6b6b"
                      strokeWidth={1}
                      dot={false}
                      isAnimationActive={false}
                      name="W Axis"
                    />
                    {repMarks.map((mark, index) => (
                      <ReferenceLine
                        key={index}
                        x={mark.time}
                        stroke={
                          mark.type === "HAMMER_CURL"
                            ? "#ff9800"
                            : mark.type === "NORMAL_CURL"
                              ? "#4caf50"
                              : mark.type === "CROSSBODY_HAMMER"
                                ? "#2196f3"
                                : mark.type === "ARNOLD_PRESS"
                                  ? "#9c27b0"
                                  : mark.type === "GOBLET_SQUAT"
                                    ? "#009688"
                                    : "#9e9e9e"
                        }
                        strokeWidth={2}
                        strokeDasharray="3 3"
                        label={{
                          value:
                            mark.type === "HAMMER_CURL"
                              ? "🔨"
                              : mark.type === "NORMAL_CURL"
                                ? "💪"
                                : mark.type === "CROSSBODY_HAMMER"
                                  ? "↗️"
                                  : mark.type === "ARNOLD_PRESS"
                                    ? "🔄"
                                    : mark.type === "GOBLET_SQUAT"
                                      ? "🦵"
                                      : "?",
                          position: "top",
                          fill:
                            mark.type === "HAMMER_CURL"
                              ? "#ff9800"
                              : mark.type === "NORMAL_CURL"
                                ? "#4caf50"
                                : mark.type === "CROSSBODY_HAMMER"
                                  ? "#2196f3"
                                  : mark.type === "ARNOLD_PRESS"
                                    ? "#9c27b0"
                                    : mark.type === "GOBLET_SQUAT"
                                      ? "#009688"
                                      : "#9e9e9e",
                        }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

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
              <strong>Status:</strong>{" "}
              {connected ? "Connected" : "Disconnected"}
              {csvMode && " | CSV Mode"}
              {connected && " | "}
              {connected && `Data Points: ${graphData.length}`}
            </div>
            <div>
              <strong>Current State:</strong>{" "}
              {latestRef.current.state || "IDLE"}
            </div>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
              {Object.keys(exerciseColors).map((exercise) => (
                <div
                  key={exercise}
                  style={{ display: "flex", alignItems: "center", gap: "5px" }}
                >
                  <div
                    style={{
                      width: "12px",
                      height: "12px",
                      backgroundColor: exerciseColors[exercise],
                      borderRadius: "2px",
                    }}
                  ></div>
                  <span>{exerciseNames[exercise]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
