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

// Import exercise images
import normalCurlImage from "./assets/bicep-curls.avif";
import hammerCurlImage from "./assets/cross_hammer.jfif";
import crossbodyHammerImage from "./assets/cross_hammer.jfif";
import arnoldPressImage from "./assets/arnold-press.jpg";
import gobletSquatImage from "./assets/goblet.avif";

// Use placeholder images if actual images aren't available
const exerciseImages = {
  NORMAL_CURL:
    normalCurlImage ||
    "https://via.placeholder.com/150/4CAF50/FFFFFF?text=Normal+Curl",
  HAMMER_CURL:
    hammerCurlImage ||
    "https://via.placeholder.com/150/FF9800/FFFFFF?text=Hammer+Curl",
  CROSSBODY_HAMMER:
    crossbodyHammerImage ||
    "https://via.placeholder.com/150/2196F3/FFFFFF?text=Crossbody+Hammer",
  ARNOLD_PRESS:
    arnoldPressImage ||
    "https://via.placeholder.com/150/9C27B0/FFFFFF?text=Arnold+Press",
  GOBLET_SQUAT:
    gobletSquatImage ||
    "https://via.placeholder.com/150/009688/FFFFFF?text=Goblet+Squat",
};

/* ================= CONFIG ================= */
const FS = 50; // Sampling frequency from your data (100ms intervals)
const LP_ALPHA = 0.25; // Adjusted low-pass filter coefficient
const ACC_ALPHA = 0.5; // Gravity estimation smoothing

// Optimized thresholds based on your CSV data analysis
const EXERCISE_THRESHOLDS = {
  NORMAL_CURL: {
    MIN_GYRO: 0.8,
    MIN_REP_GYRO: 2,
    ENERGY_THRESH: 1.5,
    MIN_REP_MS: 950,
    MIN_VERT_ACC: 0.2,
    MAX_VERT_ACC: 1.5,
    GYRO_PEAK_THRESH: 0.2,
    MIN_U_RATIO: 0.6, // Minimum U-axis ratio for good form
    MAX_V_RATIO: 0.3, // Maximum V-axis ratio for good form
  },
  HAMMER_CURL: {
    MIN_GYRO: 0.8,
    MIN_REP_GYRO: 1.5,
    ENERGY_THRESH: 2.0,
    MIN_REP_MS: 800,
    MIN_VERT_ACC: 0.2,
    MAX_VERT_ACC: 1.5,
    GYRO_PEAK_THRESH: 0.4,
    MIN_V_RATIO: 0.6, // Minimum V-axis ratio for good form
    MAX_U_RATIO: 0.3, // Maximum U-axis ratio for good form
  },
  CROSSBODY_HAMMER: {
    MIN_GYRO: 1.0,
    MIN_REP_GYRO: 2.0,
    ENERGY_THRESH: 3.0,
    MIN_REP_MS: 1200,
    MIN_VERT_ACC: 0.3,
    MAX_VERT_ACC: 2.0,
    GYRO_PEAK_THRESH: 0.6,
    MIN_V_RATIO: 0.7, // Higher V-axis ratio for crossbody
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
    MIN_W_RATIO: 0.5, // Minimum W-axis rotation
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
    MIN_W_ACC: 1.5, // Minimum vertical acceleration
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
function createExerciseDetector(selectedExercise) {
  // Rep counts for each exercise with Good/Bad tracking
  let exerciseStats = {
    NORMAL_CURL: { good: 0, bad: 0, total: 0 },
    HAMMER_CURL: { good: 0, bad: 0, total: 0 },
    CROSSBODY_HAMMER: { good: 0, bad: 0, total: 0 },
    ARNOLD_PRESS: { good: 0, bad: 0, total: 0 },
    GOBLET_SQUAT: { good: 0, bad: 0, total: 0 },
  };

  let currentExercise = selectedExercise;
  let lastRepTime = 0;

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
      verticalAcceleration: aW,
      rawAcc: [...acc],
      rawGyro: [...gyro],
      timestamp: Date.now(),
    };
  }

  // Check if rep has good form
  function checkGoodForm(features, exerciseType) {
    const { axisRatios, verticalAcceleration, gyroMag } = features;
    const { gURatio, gVRatio, gWRatio } = axisRatios;
    const thresholds = EXERCISE_THRESHOLDS[exerciseType];

    switch (exerciseType) {
      case "NORMAL_CURL":
        // Good form: High U-axis rotation, low V-axis movement
        return (
          gURatio >= thresholds.MIN_U_RATIO &&
          gVRatio <= thresholds.MAX_V_RATIO &&
          gyroMag >= thresholds.MIN_REP_GYRO * 0.7
        );

      case "HAMMER_CURL":
        // Good form: High V-axis movement, low U-axis rotation
        return (
          gVRatio >= thresholds.MIN_V_RATIO &&
          gURatio <= thresholds.MAX_U_RATIO &&
          gyroMag >= thresholds.MIN_REP_GYRO * 0.7
        );

      case "CROSSBODY_HAMMER":
        // Good form: Very high V-axis movement
        return (
          gVRatio >= thresholds.MIN_V_RATIO && Math.abs(gV) > Math.abs(gU) * 1.5
        );

      case "ARNOLD_PRESS":
        // Good form: Significant rotation (W-axis)
        return (
          gWRatio >= thresholds.MIN_W_RATIO &&
          Math.abs(gW) > Math.abs(gU) &&
          Math.abs(gW) > Math.abs(gV)
        );

      case "GOBLET_SQUAT":
        // Good form: Good vertical acceleration
        return (
          Math.abs(verticalAcceleration) >= thresholds.MIN_W_ACC &&
          gyroMag < 2.0 // Low rotation during squats
        );

      default:
        return false;
    }
  }

  // Rep detection logic
  function detectRep(features, timestamp) {
    const { gyroMag, verticalAcc, axisRatios } = features;

    if (!currentExercise) return { repDetected: false, isGoodForm: false };

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
    let isGoodForm = false;

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
            break;

          case "CROSSBODY_HAMMER":
            // Crossbody: check for V-axis dominance
            isValidRep = axisRatios.gVRatio > axisRatios.gURatio * 1.2;
            break;

          case "HAMMER_CURL":
            // Hammer curl: V-axis should dominate
            isValidRep = axisRatios.gVRatio > axisRatios.gURatio;
            break;

          case "NORMAL_CURL":
            // Normal curl: U-axis should dominate
            isValidRep = axisRatios.gURatio > axisRatios.gVRatio;
            break;

          default:
            isValidRep = energy > thresholds.ENERGY_THRESH;
        }

        if (isValidRep) {
          repDetected = true;
          isGoodForm = checkGoodForm(features, currentExercise);
          lastRepTime = timestamp;

          // Update stats for the selected exercise
          if (exerciseStats[currentExercise]) {
            exerciseStats[currentExercise].total++;
            if (isGoodForm) {
              exerciseStats[currentExercise].good++;
            } else {
              exerciseStats[currentExercise].bad++;
            }
          }

          // Reset for next rep
          state = "IDLE";
          energy = 0;
        }
      }
    }

    return {
      repDetected,
      isGoodForm,
      exerciseType: currentExercise,
    };
  }

  function update(gyro, acc) {
    const timestamp = Date.now();

    // Extract features
    const features = extractFeatures(gyro, acc);

    // Detect rep
    const repResult = detectRep(features, timestamp);

    return {
      value: features.gyroMag,
      repDetected: repResult.repDetected,
      isGoodForm: repResult.isGoodForm,
      repType: currentExercise,
      exercise: currentExercise,
      exerciseStats: { ...exerciseStats },
      state,
      energy,
      gU: features.gU,
      gV: features.gV,
      gW: features.gW,
      axisRatios: features.axisRatios,
      features,
      timestamp,
    };
  }

  function reset() {
    exerciseStats = {
      NORMAL_CURL: { good: 0, bad: 0, total: 0 },
      HAMMER_CURL: { good: 0, bad: 0, total: 0 },
      CROSSBODY_HAMMER: { good: 0, bad: 0, total: 0 },
      ARNOLD_PRESS: { good: 0, bad: 0, total: 0 },
      GOBLET_SQUAT: { good: 0, bad: 0, total: 0 },
    };
    state = "IDLE";
    lastRepTime = 0;
    resetForNewExercise();
  }

  function setExercise(exercise) {
    currentExercise = exercise;
    resetForNewExercise();
  }

  function getExerciseStats() {
    return { ...exerciseStats };
  }

  function getCurrentExerciseStats() {
    return currentExercise
      ? exerciseStats[currentExercise]
      : { good: 0, bad: 0, total: 0 };
  }

  return {
    update,
    reset,
    setExercise,
    getExerciseStats,
    getCurrentExerciseStats,
    getExercise: () => currentExercise,
  };
}

const log = [];

/* ================= CSV PROCESSOR ================= */
function createCSVProcessor() {
  let csvData = [];
  let currentIndex = 0;
  let detector = null;

  function parseCSV(csvText, selectedExercise) {
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
    detector = createExerciseDetector(selectedExercise);
  }

  function getNextSample() {
    if (currentIndex >= csvData.length) return null;

    const sample = csvData[currentIndex];
    currentIndex++;

    // Convert to arrays
    const acc = [sample.ax, sample.ay, sample.az];
    const gyro = [sample.gx, sample.gy, sample.gz];

    // Process through detector
    const result = detector.update(gyro, acc);

    // Log for comparison
    log.push({
      ...sample,
      detectedRep: result.repDetected,
      detectedExercise: result.exercise,
      isGoodForm: result.isGoodForm,
      timestamp: Date.now(),
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

  function setExercise(exercise) {
    if (detector) {
      detector.setExercise(exercise);
    }
  }

  return {
    parseCSV,
    getNextSample,
    getAllData,
    reset,
    setExercise,
  };
}

/* ================= MAIN APP ================= */
export default function DumbbellRepCounter() {
  // Refs for BLE and detector
  const detectorRef = useRef(null);
  const csvProcessorRef = useRef(null);
  const deviceRef = useRef(null);
  const charRef = useRef(null);
  const rafRef = useRef(null);
  const notificationHandlerRef = useRef(null);
  const startedRef = useRef(false);

  // Latest sensor data and detection results
  const latestRef = useRef({
    exerciseStats: {
      NORMAL_CURL: { good: 0, bad: 0, total: 0 },
      HAMMER_CURL: { good: 0, bad: 0, total: 0 },
      CROSSBODY_HAMMER: { good: 0, bad: 0, total: 0 },
      ARNOLD_PRESS: { good: 0, bad: 0, total: 0 },
      GOBLET_SQUAT: { good: 0, bad: 0, total: 0 },
    },
    value: 0,
    repDetected: false,
    isGoodForm: false,
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
  const [exerciseStats, setExerciseStats] = useState({
    NORMAL_CURL: { good: 0, bad: 0, total: 0 },
    HAMMER_CURL: { good: 0, bad: 0, total: 0 },
    CROSSBODY_HAMMER: { good: 0, bad: 0, total: 0 },
    ARNOLD_PRESS: { good: 0, bad: 0, total: 0 },
    GOBLET_SQUAT: { good: 0, bad: 0, total: 0 },
  });
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
  const [csvMode, setCsvMode] = useState(false);
  const [csvFile, setCsvFile] = useState(null);
  const [processingCSV, setProcessingCSV] = useState(false);
  const [selectedGraph, setSelectedGraph] = useState("ALL");
  const [showExerciseSelection, setShowExerciseSelection] = useState(true);

  // Data rate calculation
  const dataRateRef = useRef({ count: 0, lastCalc: Date.now() });

  // Initialize detector when exercise is selected
  useEffect(() => {
    if (currentExercise) {
      detectorRef.current = createExerciseDetector(currentExercise);
      csvProcessorRef.current = createCSVProcessor();
      setShowExerciseSelection(false);
    }
  }, [currentExercise]);

  /* ================= CSV HANDLING ================= */
  const handleCSVUpload = useCallback(
    (event) => {
      const file = event.target.files[0];
      if (!file) return;

      if (!currentExercise) {
        setError("Please select an exercise type first");
        return;
      }

      setCsvFile(file);

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          csvProcessorRef.current.parseCSV(e.target.result, currentExercise);
          setCsvMode(true);
          setProcessingCSV(true);
          setError(null);
          console.log("CSV loaded successfully");
        } catch (err) {
          setError(`CSV parsing error: ${err.message}`);
        }
      };
      reader.readAsText(file);
    },
    [currentExercise],
  );

  const processNextCSVSample = useCallback(() => {
    if (!processingCSV || !csvProcessorRef.current) return;

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
      if (!currentExercise) {
        setError("Please select an exercise type first");
        return;
      }

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
  }, [currentExercise]);

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

          if (!detectorRef.current) return;

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

              if (!detectorRef.current) return;

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
        isGoodForm: entry.isGoodForm ? "Good" : "Bad",
        groundTruth: entry.exercise,
      })),
    );

    // Add exercise summary
    const summary = [
      ["Exercise Summary"],
      [
        "Selected Exercise",
        currentExercise ? exerciseNames[currentExercise] : "None",
      ],
      [],
      ["Exercise", "Good Reps", "Bad Reps", "Total Reps"],
      [
        "Normal Curls",
        exerciseStats.NORMAL_CURL.good,
        exerciseStats.NORMAL_CURL.bad,
        exerciseStats.NORMAL_CURL.total,
      ],
      [
        "Hammer Curls",
        exerciseStats.HAMMER_CURL.good,
        exerciseStats.HAMMER_CURL.bad,
        exerciseStats.HAMMER_CURL.total,
      ],
      [
        "Crossbody Hammer",
        exerciseStats.CROSSBODY_HAMMER.good,
        exerciseStats.CROSSBODY_HAMMER.bad,
        exerciseStats.CROSSBODY_HAMMER.total,
      ],
      [
        "Arnold Press",
        exerciseStats.ARNOLD_PRESS.good,
        exerciseStats.ARNOLD_PRESS.bad,
        exerciseStats.ARNOLD_PRESS.total,
      ],
      [
        "Goblet Squat",
        exerciseStats.GOBLET_SQUAT.good,
        exerciseStats.GOBLET_SQUAT.bad,
        exerciseStats.GOBLET_SQUAT.total,
      ],
      [],
      [
        "Total All Exercises",
        Object.values(exerciseStats).reduce((sum, stat) => sum + stat.good, 0),
        Object.values(exerciseStats).reduce((sum, stat) => sum + stat.bad, 0),
        Object.values(exerciseStats).reduce((sum, stat) => sum + stat.total, 0),
      ],
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
    if (detectorRef.current) {
      detectorRef.current.reset();
    }
    if (csvProcessorRef.current) {
      csvProcessorRef.current.reset();
    }
    latestRef.current = {
      exerciseStats: {
        NORMAL_CURL: { good: 0, bad: 0, total: 0 },
        HAMMER_CURL: { good: 0, bad: 0, total: 0 },
        CROSSBODY_HAMMER: { good: 0, bad: 0, total: 0 },
        ARNOLD_PRESS: { good: 0, bad: 0, total: 0 },
        GOBLET_SQUAT: { good: 0, bad: 0, total: 0 },
      },
      value: 0,
      repDetected: false,
      isGoodForm: false,
      repType: null,
      exercise: currentExercise,
      state: "IDLE",
      energy: 0,
      gU: 0,
      gV: 0,
      gW: 0,
      lastUpdate: Date.now(),
    };
    startedRef.current = false;
    setExerciseStats({
      NORMAL_CURL: { good: 0, bad: 0, total: 0 },
      HAMMER_CURL: { good: 0, bad: 0, total: 0 },
      CROSSBODY_HAMMER: { good: 0, bad: 0, total: 0 },
      ARNOLD_PRESS: { good: 0, bad: 0, total: 0 },
      GOBLET_SQUAT: { good: 0, bad: 0, total: 0 },
    });
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
    setCsvMode(false);
    setProcessingCSV(false);
    setSelectedGraph("ALL");
  }, [currentExercise]);

  const setExercise = (exercise) => {
    setCurrentExercise(exercise);
    if (detectorRef.current) {
      detectorRef.current.setExercise(exercise);
    }
    if (csvProcessorRef.current) {
      csvProcessorRef.current.setExercise(exercise);
    }
    resetCounts();
  };

  const changeExercise = () => {
    setCurrentExercise(null);
    setShowExerciseSelection(true);
    resetCounts();
  };

  /* ================= UI UPDATE LOOP ================= */
  useEffect(() => {
    let lastGraphUpdate = 0;
    const GRAPH_UPDATE_MS = 100; // Match CSV interval

    const updateLoop = () => {
      const now = Date.now();
      const data = latestRef.current;

      // Update stats
      setExerciseStats(data.exerciseStats);

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
            exercise: currentExercise,
          };

          const newData = [...prev.slice(-200), newPoint];
          return newData;
        });

        // Update exercise-specific graphs
        if (currentExercise && exerciseGraphs[currentExercise]) {
          setExerciseGraphs((prev) => {
            const newPoint = {
              time: now,
              value: data.value,
              gU: data.gU || 0,
              gV: data.gV || 0,
              gW: data.gW || 0,
              exercise: currentExercise,
            };

            const updatedGraphs = { ...prev };
            updatedGraphs[currentExercise] = [
              ...prev[currentExercise].slice(-100),
              newPoint,
            ];
            return updatedGraphs;
          });
        }

        if (data.repDetected) {
          setRepMarks((prev) => {
            const newMark = {
              time: now,
              value: data.value,
              type: data.repType,
              isGoodForm: data.isGoodForm,
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
  }, [currentExercise, exerciseGraphs]);

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

  // Calculate totals
  const totalStats = {
    good: Object.values(exerciseStats).reduce(
      (sum, stat) => sum + stat.good,
      0,
    ),
    bad: Object.values(exerciseStats).reduce((sum, stat) => sum + stat.bad, 0),
    total: Object.values(exerciseStats).reduce(
      (sum, stat) => sum + stat.total,
      0,
    ),
  };

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

  // Prepare data for bar chart
  const barChartData = Object.keys(exerciseNames).map((exercise) => ({
    name: exerciseNames[exercise],
    good: exerciseStats[exercise].good,
    bad: exerciseStats[exercise].bad,
    color: exerciseColors[exercise],
  }));

  // Get current graph data based on selection
  const getCurrentGraphData = () => {
    if (selectedGraph === "ALL") {
      return graphData;
    }
    return exerciseGraphs[selectedGraph] || [];
  };

  /* ================= EXERCISE SELECTION SCREEN ================= */
  if (showExerciseSelection) {
    return (
      <div
        style={{
          padding: "40px",
          width: "99vw",
          margin: "0 auto",
          fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif",
          backgroundColor: "#f5f5f5",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            backgroundColor: "white",
            borderRadius: "20px",
            padding: "40px",
            boxShadow: "0 10px 40px rgba(0,0,0,0.1)",
            textAlign: "center",
            width: "100%",
            maxWidth: "1000px",
          }}
        >
          <h1
            style={{ color: "#2c3e50", fontSize: "36px", marginBottom: "10px" }}
          >
            🏋️‍♂️ Select Your Exercise
          </h1>
          <p style={{ color: "#666", fontSize: "18px", marginBottom: "40px" }}>
            Choose the exercise you want to perform
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: "30px",
              marginBottom: "40px",
            }}
          >
            {Object.keys(exerciseNames).map((exercise) => (
              <div
                key={exercise}
                onClick={() => setExercise(exercise)}
                style={{
                  backgroundColor: "#f8f9fa",
                  borderRadius: "15px",
                  padding: "25px",
                  textAlign: "center",
                  boxShadow: "0 5px 15px rgba(0,0,0,0.08)",
                  cursor: "pointer",
                  transition: "all 0.3s ease",
                  border: "3px solid transparent",
                  "&:hover": {
                    transform: "translateY(-5px)",
                    boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
                    borderColor: exerciseColors[exercise],
                  },
                }}
              >
                <div
                  style={{
                    width: "150px",
                    height: "150px",
                    borderRadius: "10px",
                    overflow: "hidden",
                    margin: "0 auto 20px",
                    border: `3px solid ${exerciseColors[exercise]}`,
                  }}
                >
                  <img
                    src={exerciseImages[exercise]}
                    alt={exerciseNames[exercise]}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                </div>
                <h3
                  style={{
                    color: exerciseColors[exercise],
                    fontSize: "24px",
                    margin: "10px 0",
                    fontWeight: "600",
                  }}
                >
                  {exerciseNames[exercise]}
                </h3>
                <p style={{ color: "#666", fontSize: "14px" }}>
                  {exercise === "NORMAL_CURL" &&
                    "Forearm rotation with palm-up grip"}
                  {exercise === "HAMMER_CURL" &&
                    "Neutral grip with vertical movement"}
                  {exercise === "CROSSBODY_HAMMER" &&
                    "Diagonal movement across body"}
                  {exercise === "ARNOLD_PRESS" && "Rotational shoulder press"}
                  {exercise === "GOBLET_SQUAT" &&
                    "Deep squat with vertical movement"}
                </p>
                <div
                  style={{
                    backgroundColor: exerciseColors[exercise],
                    color: "white",
                    padding: "8px 16px",
                    borderRadius: "20px",
                    fontSize: "14px",
                    fontWeight: "500",
                    marginTop: "15px",
                    display: "inline-block",
                  }}
                >
                  Select Exercise
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* ================= MAIN APP SCREEN ================= */
  return (
    <div
      style={{
        padding: "20px",
        width: "90vw",
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
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "30px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
            <div
              style={{
                width: "80px",
                height: "80px",
                borderRadius: "10px",
                overflow: "hidden",
                border: `3px solid ${exerciseColors[currentExercise]}`,
              }}
            >
              <img
                src={exerciseImages[currentExercise]}
                alt={exerciseNames[currentExercise]}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            </div>
            <div>
              <h1 style={{ margin: 0, color: "#2c3e50", fontSize: "28px" }}>
                {exerciseNames[currentExercise]}
              </h1>
              <p style={{ margin: "5px 0 0", color: "#666", fontSize: "14px" }}>
                Real-time form analysis and rep counting
              </p>
            </div>
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              onClick={changeExercise}
              style={{
                padding: "10px 20px",
                backgroundColor: "#ff9800",
                color: "white",
                border: "none",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: "500",
                cursor: "pointer",
              }}
            >
              🔄 Change Exercise
            </button>
            <button
              onClick={exportToExcel}
              style={{
                padding: "10px 20px",
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
          </div>
        </div>

        {/* Connection Controls */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "20px",
            marginBottom: "24px",
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
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
              🔄 Reset Counts
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

        {/* Current Exercise Stats */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
            gap: "20px",
            marginBottom: "30px",
          }}
        >
          <div
            style={{
              backgroundColor: "#4CAF50",
              borderRadius: "10px",
              padding: "20px",
              textAlign: "center",
              color: "white",
            }}
          >
            <div style={{ fontSize: "14px", marginBottom: "8px" }}>
              GOOD REPS
            </div>
            <div style={{ fontSize: "36px", fontWeight: "700" }}>
              {exerciseStats[currentExercise]?.good || 0}
            </div>
            <div style={{ fontSize: "12px", opacity: 0.9 }}>
              Proper form detected
            </div>
          </div>

          <div
            style={{
              backgroundColor: "#f44336",
              borderRadius: "10px",
              padding: "20px",
              textAlign: "center",
              color: "white",
            }}
          >
            <div style={{ fontSize: "14px", marginBottom: "8px" }}>
              BAD REPS
            </div>
            <div style={{ fontSize: "36px", fontWeight: "700" }}>
              {exerciseStats[currentExercise]?.bad || 0}
            </div>
            <div style={{ fontSize: "12px", opacity: 0.9 }}>
              Form needs improvement
            </div>
          </div>

          <div
            style={{
              backgroundColor: "#2196F3",
              borderRadius: "10px",
              padding: "20px",
              textAlign: "center",
              color: "white",
            }}
          >
            <div style={{ fontSize: "14px", marginBottom: "8px" }}>
              TOTAL REPS
            </div>
            <div style={{ fontSize: "36px", fontWeight: "700" }}>
              {exerciseStats[currentExercise]?.total || 0}
            </div>
            <div style={{ fontSize: "12px", opacity: 0.9 }}>Combined count</div>
          </div>

          <div
            style={{
              backgroundColor: "#FF9800",
              borderRadius: "10px",
              padding: "20px",
              textAlign: "center",
              color: "white",
            }}
          >
            <div style={{ fontSize: "14px", marginBottom: "8px" }}>
              SUCCESS RATE
            </div>
            <div style={{ fontSize: "36px", fontWeight: "700" }}>
              {exerciseStats[currentExercise]?.total > 0
                ? `${Math.round(
                    (exerciseStats[currentExercise].good /
                      exerciseStats[currentExercise].total) *
                      100,
                  )}%`
                : "0%"}
            </div>
            <div style={{ fontSize: "12px", opacity: 0.9 }}>
              Good form percentage
            </div>
          </div>
        </div>

        {/* All Exercises Summary */}
        <div
          style={{
            backgroundColor: "#f8f9fa",
            borderRadius: "10px",
            padding: "20px",
            marginBottom: "30px",
          }}
        >
          <h3 style={{ margin: "0 0 20px 0", color: "#2c3e50" }}>
            📊 All Exercises Summary
          </h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "15px",
            }}
          >
            {Object.keys(exerciseNames).map((exercise) => (
              <div
                key={exercise}
                style={{
                  backgroundColor: "white",
                  borderRadius: "8px",
                  padding: "15px",
                  borderLeft: `4px solid ${exerciseColors[exercise]}`,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.05)",
                }}
              >
                <div
                  style={{
                    fontSize: "12px",
                    color: exerciseColors[exercise],
                    fontWeight: "600",
                    marginBottom: "5px",
                  }}
                >
                  {exerciseNames[exercise]}
                </div>
                <div
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <div>
                    <div style={{ fontSize: "10px", color: "#666" }}>Good</div>
                    <div
                      style={{
                        fontSize: "16px",
                        fontWeight: "600",
                        color: "#4CAF50",
                      }}
                    >
                      {exerciseStats[exercise].good}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "10px", color: "#666" }}>Bad</div>
                    <div
                      style={{
                        fontSize: "16px",
                        fontWeight: "600",
                        color: "#f44336",
                      }}
                    >
                      {exerciseStats[exercise].bad}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "10px", color: "#666" }}>Total</div>
                    <div
                      style={{
                        fontSize: "16px",
                        fontWeight: "600",
                        color: "#2196F3",
                      }}
                    >
                      {exerciseStats[exercise].total}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Graph Selection */}
        {graphData.length > 0 && (
          <>
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
                  All Data
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
            <div
              style={{
                backgroundColor: "white",
                padding: "20px",
                borderRadius: "12px",
                boxShadow: "0 2px 10px rgba(0,0,0,0.05)",
                marginBottom: "24px",
              }}
            >
              <div style={{ width: "100%", height: "300px" }}>
                <ResponsiveContainer>
                  <LineChart data={getCurrentGraphData()}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                    <XAxis
                      dataKey="time"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(unixTime) => {
                        const date = new Date(unixTime);
                        return `${date
                          .getSeconds()
                          .toString()
                          .padStart(2, "0")}.${Math.floor(
                          date.getMilliseconds() / 100,
                        )}`;
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
                        stroke={mark.isGoodForm ? "#4CAF50" : "#f44336"}
                        strokeWidth={2}
                        strokeDasharray="3 3"
                        label={{
                          value: mark.isGoodForm ? "✓" : "✗",
                          position: "top",
                          fill: mark.isGoodForm ? "#4CAF50" : "#f44336",
                          fontSize: "16px",
                        }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
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

        {/* Error Display */}
        {error && (
          <div
            style={{
              backgroundColor: "#ffebee",
              color: "#c62828",
              padding: "12px 16px",
              borderRadius: "8px",
              marginTop: "20px",
              border: "1px solid #ffcdd2",
            }}
          >
            <strong>Error:</strong> {error}
          </div>
        )}
      </div>
    </div>
  );
}
