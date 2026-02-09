// App.js
import React, { useState, useEffect, useRef } from 'react';
import './WithendPoint.css';

// Chart.js for graphing
import {
  Chart as ChartJS,
  LineElement,
  PointElement,
  LinearScale,
  Title,
  Tooltip,
  Legend,
  TimeScale
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import 'chartjs-adapter-date-fns';

// Register ChartJS components
ChartJS.register(
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Title,
  Tooltip,
  Legend
);

function WithEndPoint() {
  const [sensorData, setSensorData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(2000);
  const [history, setHistory] = useState([]);
  const [graphData, setGraphData] = useState({
    accel: { labels: [], datasets: [] },
    gyro: { labels: [], datasets: [] }
  });
  
  const historyRef = useRef([]);
  const MAX_HISTORY = 50;

  const predictionConfigs = {
    'cross_body': { color: '#3B82F6', icon: '↔️', label: 'Cross Body', bgColor: 'rgba(59, 130, 246, 0.1)' },
    'normal': { color: '#10B981', icon: '🔄', label: 'Normal Curl', bgColor: 'rgba(16, 185, 129, 0.1)' },
    'harnold': { color: '#F59E0B', icon: '💪', label: 'Harnold Press', bgColor: 'rgba(245, 158, 11, 0.1)' },
    'gonlet': { color: '#8B5CF6', icon: '🏋️', label: 'Gonlet Swing', bgColor: 'rgba(139, 92, 246, 0.1)' },
    'rest': { color: '#6B7280', icon: '⏸️', label: 'Rest', bgColor: 'rgba(107, 114, 128, 0.1)' }
  };

  const chartColors = {
    ax: '#EF4444', // Red
    ay: '#10B981', // Green
    az: '#3B82F6', // Blue
    gx: '#F59E0B', // Orange
    gy: '#8B5CF6', // Purple
    gz: '#EC4899'  // Pink
  };

  const fetchData = async () => {
    try {
      const response = await fetch('http://192.168.0.17:8000/data');
      if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
      
      const data = await response.json();
      setSensorData(data);
      
      // Update history
      const newHistory = {
        timestamp: new Date().toISOString(),
        prediction: data.latest_prediction,
        confidence: data.latest_confidence,
        isRest: data.latest_is_rest,
        sample: data.samples?.[0]
      };
      
      historyRef.current = [newHistory, ...historyRef.current.slice(0, MAX_HISTORY - 1)];
      setHistory(historyRef.current);
      
      // Update graph data
      if (data.samples?.[0]) {
        updateGraphData(newHistory);
      }
      
      setError(null);
    } catch (err) {
      setError(`Failed to fetch: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const updateGraphData = (newData) => {
    const timestamp = new Date(newData.timestamp);
    const sample = newData.sample;
    
    setGraphData(prev => {
      const newLabels = [...prev.accel.labels, timestamp];
      if (newLabels.length > MAX_HISTORY) newLabels.shift();
      
      const updateDataset = (key, label, color) => {
        const existing = prev.accel.datasets.find(ds => ds.label === label);
        const values = existing ? [...existing.data, sample[key]] : [sample[key]];
        if (values.length > MAX_HISTORY) values.shift();
        
        return {
          label,
          data: values,
          borderColor: color,
          backgroundColor: color + '20',
          borderWidth: 2,
          tension: 0.4,
          pointRadius: 2
        };
      };
      
      return {
        accel: {
          labels: newLabels,
          datasets: [
            updateDataset('ax', 'Accel X', chartColors.ax),
            updateDataset('ay', 'Accel Y', chartColors.ay),
            updateDataset('az', 'Accel Z', chartColors.az)
          ]
        },
        gyro: {
          labels: newLabels,
          datasets: [
            updateDataset('gx', 'Gyro X', chartColors.gx),
            updateDataset('gy', 'Gyro Y', chartColors.gy),
            updateDataset('gz', 'Gyro Z', chartColors.gz)
          ]
        }
      };
    });
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 0
    },
    scales: {
      x: {
        type: 'time',
        time: {
          unit: 'second',
          displayFormats: {
            second: 'HH:mm:ss'
          }
        },
        grid: {
          color: 'rgba(0,0,0,0.05)'
        }
      },
      y: {
        grid: {
          color: 'rgba(0,0,0,0.05)'
        }
      }
    },
    plugins: {
      legend: {
        position: 'top',
      },
      tooltip: {
        mode: 'index',
        intersect: false
      }
    },
    interaction: {
      intersect: false,
      mode: 'nearest'
    }
  };

  useEffect(() => {
    fetchData();
    
    if (autoRefresh) {
      const interval = setInterval(fetchData, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, refreshInterval]);

  const normalizeValue = (value, max = 10) => {
    const clamped = Math.max(-max, Math.min(max, value));
    return (clamped / max) * 100;
  };

  const renderMeter = (label, value, color, max = 10) => {
    const width = Math.abs(normalizeValue(value, max));
    return (
      <div className="meter">
        <div className="meter-label">
          <span>{label}</span>
          <span>{value.toFixed(4)}</span>
        </div>
        <div className="meter-bar">
          <div 
            className="meter-fill"
            style={{
              width: `${width}%`,
              backgroundColor: color,
              marginLeft: value < 0 ? `${100 - width}%` : '0'
            }}
          ></div>
        </div>
        <div className="meter-scale">
          <span>-{max}</span>
          <span>0</span>
          <span>+{max}</span>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <p>Connecting to IMU Sensor...</p>
      </div>
    );
  }

  const currentConfig = sensorData?.latest_prediction ? 
    predictionConfigs[sensorData.latest_prediction] : 
    { color: '#6B7280', icon: '❓', label: 'Unknown', bgColor: 'rgba(107, 114, 128, 0.1)' };

  const confidencePercent = sensorData ? Math.round(sensorData.latest_confidence * 100) : 0;

  return (
    <div className="app-container">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <h1><i className="fas fa-dumbbell"></i> IMU Exercise Monitor</h1>
          <p className="subtitle">Real-time Motion Analysis Dashboard</p>
        </div>
        
        <div className="header-right">
          <div className="connection-status">
            <div className={`status-dot ${error ? 'disconnected' : 'connected'}`}></div>
            <span>{error ? 'Disconnected' : 'Connected'}</span>
          </div>
          
          <div className="controls">
            <button onClick={fetchData} className="btn btn-primary">
              <i className="fas fa-sync-alt"></i> Refresh
            </button>
            
            <label className="toggle">
              <input 
                type="checkbox" 
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              <span>Auto-refresh</span>
            </label>
            
            <select 
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              className="interval-select"
            >
              <option value={1000}>1 sec</option>
              <option value={2000}>2 sec</option>
              <option value={5000}>5 sec</option>
              <option value={10000}>10 sec</option>
            </select>
          </div>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <i className="fas fa-exclamation-triangle"></i>
          <span>{error}</span>
          <button onClick={fetchData} className="btn btn-small">
            Retry
          </button>
        </div>
      )}

      {/* Main Dashboard */}
      <div className="dashboard">
        {/* Prediction Card */}
        <div className="card prediction-card text-center" style={{ width: '100%' }}>
          <div className="card-header">
            <h2><i className="fas fa-chart-line"></i> Current Prediction</h2>
            <div className={`status-badge ${sensorData?.latest_is_rest ? 'rest' : 'active'}`}>
              {sensorData?.latest_is_rest ? 'RESTING' : 'ACTIVE'}
            </div>
          </div>
          
          <div className="prediction-content">
            <div className="prediction-icon">{currentConfig.icon}</div>
            <div className="prediction-details">
              <div className="prediction-name">{currentConfig.label}</div>
              <div className="prediction-value" style={{ color: currentConfig.color }}>
                {sensorData?.latest_prediction?.toUpperCase()?.replace('_', ' ') || 'UNKNOWN'}
              </div>
            </div>
            
            <div className="confidence-section">
              <div className="confidence-header">
                <span>Confidence</span>
                <span className="confidence-percent" style={{
                  color: confidencePercent > 80 ? '#10B981' : 
                         confidencePercent > 60 ? '#F59E0B' : '#EF4444'
                }}>
                  {confidencePercent}%
                </span>
              </div>
              <div className="confidence-bar">
                <div 
                  className="confidence-fill"
                  style={{ 
                    width: `${confidencePercent}%`,
                    backgroundColor: confidencePercent > 80 ? '#10B981' : 
                                   confidencePercent > 60 ? '#F59E0B' : '#EF4444'
                  }}
                ></div>
              </div>
            </div>
          </div>
        </div>

        {/* Live Graphs */}
        <div className="card graph-card">
          <div className="card-header">
            <h2><i className="fas fa-wave-square"></i> Acceleration Live Graph (g)</h2>
          </div>
          <div className="graph-container">
            <Line data={graphData.accel} options={chartOptions} />
          </div>
        </div>

        <div className="card graph-card">
          <div className="card-header">
            <h2><i className="fas fa-compass"></i> Gyroscope Live Graph (°/s)</h2>
          </div>
          <div className="graph-container">
            <Line data={graphData.gyro} options={chartOptions} />
          </div>
        </div>

        {/* Sensor Meters */}
        <div className="card meters-card">
          <div className="card-header">
            <h2><i className="fas fa-tachometer-alt"></i> Sensor Meters</h2>
          </div>
          
          <div className="sensor-group">
            <div className="sensor-section">
              <h3>Acceleration (g)</h3>
              <div className="meters">
                {sensorData?.samples?.[0] && (
                  <>
                    {renderMeter('AX', sensorData.samples[0].ax, chartColors.ax)}
                    {renderMeter('AY', sensorData.samples[0].ay, chartColors.ay)}
                    {renderMeter('AZ', sensorData.samples[0].az, chartColors.az)}
                  </>
                )}
              </div>
            </div>
            
            <div className="sensor-section">
              <h3>Gyroscope (°/s)</h3>
              <div className="meters">
                {sensorData?.samples?.[0] && (
                  <>
                    {renderMeter('GX', sensorData.samples[0].gx, chartColors.gx, 0.01)}
                    {renderMeter('GY', sensorData.samples[0].gy, chartColors.gy, 0.01)}
                    {renderMeter('GZ', sensorData.samples[0].gz, chartColors.gz, 0.01)}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Data Table */}
        <div className="card data-card">
          <div className="card-header">
            <h2><i className="fas fa-table"></i> Current Sensor Data</h2>
            <div className="battery-display">
              <div className="battery-icon">
                <div 
                  className="battery-level"
                  style={{ width: `${sensorData?.samples?.[0]?.battery || 0}%` }}
                ></div>
              </div>
              <span>{sensorData?.samples?.[0]?.battery || 0}%</span>
            </div>
          </div>
          
          {sensorData?.samples?.[0] && (
            <div className="data-grid">
              <div className="data-row">
                <span className="data-label">Timestamp</span>
                <span className="data-value">{new Date(sensorData.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Acceleration X</span>
                <span className="data-value">{sensorData.samples[0].ax.toFixed(4)} g</span>
              </div>
              <div className="data-row">
                <span className="data-label">Acceleration Y</span>
                <span className="data-value">{sensorData.samples[0].ay.toFixed(4)} g</span>
              </div>
              <div className="data-row">
                <span className="data-label">Acceleration Z</span>
                <span className="data-value">{sensorData.samples[0].az.toFixed(4)} g</span>
              </div>
              <div className="data-row">
                <span className="data-label">Gyroscope X</span>
                <span className="data-value">{sensorData.samples[0].gx.toFixed(6)} °/s</span>
              </div>
              <div className="data-row">
                <span className="data-label">Gyroscope Y</span>
                <span className="data-value">{sensorData.samples[0].gy.toFixed(6)} °/s</span>
              </div>
              <div className="data-row">
                <span className="data-label">Gyroscope Z</span>
                <span className="data-value">{sensorData.samples[0].gz.toFixed(6)} °/s</span>
              </div>
              <div className="data-row">
                <span className="data-label">Device Timestamp</span>
                <span className="data-value">{sensorData.samples[0].device_timestamp_ms} ms</span>
              </div>
              <div className="data-row">
                <span className="data-label">Buffer Size</span>
                <span className="data-value">{sensorData.buffer_size} samples</span>
              </div>
            </div>
          )}
        </div>

        {/* Activity History */}
        <div className="card history-card">
          <div className="card-header">
            <h2><i className="fas fa-history"></i> Recent Predictions</h2>
          </div>
          
          <div className="history-list">
            {history.slice(0, 5).map((item, index) => {
              const config = predictionConfigs[item.prediction] || predictionConfigs.rest;
              return (
                <div key={index} className="history-item">
                  <div className="history-icon" style={{ color: config.color }}>
                    {config.icon}
                  </div>
                  <div className="history-details">
                    <div className="history-name">
                      {config.label}
                      <span className="history-time">
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="history-footer">
                      <span className="confidence-tag">
                        {Math.round(item.confidence * 100)}% confidence
                      </span>
                      <span className={`status-tag ${item.isRest ? 'rest' : 'active'}`}>
                        {item.isRest ? 'Rest' : 'Active'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
            
            {history.length === 0 && (
              <div className="empty-history">
                <p>No predictions recorded yet</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default WithEndPoint;