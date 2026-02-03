export function processIMURealtime(imuBuffer, fs = 50) {
    /*
    imuBuffer = [
      { ax, ay, az, gx, gy, gz, t },
      ...
    ]
    */
 
    if (imuBuffer.length < fs) {
        return null;
    }
 
    /* ================= CONFIG ================= */
    const GYRO_LP = 1.5;
    const GYRO_MIN_MAG = 0.05;
    const GYRO_MIN_REP = Math.floor(0.3 * fs);
    const GYRO_MIN_ENERGY = 0.2;
 
    const ACC_LP = 1.0;
    const ACC_MIN_MAG = 0.05;
    const ACC_MIN_REP = Math.floor(0.5 * fs);
 
    const MAX_CLASS_DIST = 5;
 
    const REFERENCE_SD = {
        BICEP:  { ax:7.03, ay:5.57, az:1.11, gx:0.34, gy:0.40, gz:2.09 },
        HAMMER: { ax:3.06, ay:1.82, az:2.85, gx:0.61, gy:1.75, gz:0.29 },
        ARNOLD: { ax:5.2,  ay:6.1,  az:3.4,  gx:0.15, gy:0.18, gz:0.22 }
    };
 
    /* ================= HELPERS ================= */
 
    const mean = arr => arr.reduce((a,b)=>a+b,0)/arr.length;
 
    const std = arr => {
        const m = mean(arr);
        return Math.sqrt(mean(arr.map(v => (v-m)**2)));
    };
 
    function movingAverage(x, win) {
        const out = [];
        for (let i=0;i<x.length;i++) {
            const s = Math.max(0, i-win);
            const e = Math.min(x.length, i+win);
            out.push(mean(x.slice(s,e)));
        }
        return out;
    }
 
    function smooth(x, cutoff) {
        const win = Math.max(1, Math.floor(0.2 * fs));
        return movingAverage(x, win);
    }
 
    /* ================= DATA ================= */
 
    const ax = imuBuffer.map(d => d.ax);
    const ay = imuBuffer.map(d => d.ay);
    const az = imuBuffer.map(d => d.az);
    const gx = imuBuffer.map(d => d.gx);
    const gy = imuBuffer.map(d => d.gy);
    const gz = imuBuffer.map(d => d.gz);
 
    /* ================= GYRO DETECTION ================= */
 
    const gyroAxes = [gx, gy, gz];
    const gyroVars = gyroAxes.map(a => std(a));
    const gAxis = gyroVars.indexOf(Math.max(...gyroVars));
    const gRaw = gyroAxes[gAxis];
    const gSig = smooth(gRaw, GYRO_LP);
 
    let gyroReps = [];
    let lastSign = 0, start = null;
 
    for (let i=0;i<gSig.length;i++) {
        const v = gSig[i];
        const sign = Math.abs(v) < GYRO_MIN_MAG ? 0 : Math.sign(v);
 
        if (sign && lastSign && sign !== lastSign) {
            if (start === null) start = i;
            else {
                if (i - start >= GYRO_MIN_REP) {
                    const E = gSig
                        .slice(start,i)
                        .reduce((a,b)=>a+Math.abs(b),0) / fs;
                    if (E > GYRO_MIN_ENERGY)
                        gyroReps.push([start,i]);
                }
                start = null;
            }
        }
        if (sign) lastSign = sign;
    }
 
    /* ================= ACCEL DETECTION ================= */
 
    const accMag = ax.map((_,i)=>
        Math.sqrt(ax[i]**2 + ay[i]**2 + az[i]**2)
    );
    const aSig = smooth(accMag, ACC_LP);
 
    let accelReps = [];
    let above = false;
    start = null;
 
    for (let i=0;i<aSig.length;i++) {
        if (aSig[i] > ACC_MIN_MAG && !above) {
            start = i;
            above = true;
        } else if (aSig[i] < ACC_MIN_MAG && above) {
            if (i-start >= ACC_MIN_REP)
                accelReps.push([start,i]);
            above = false;
        }
    }
 
    /* ================= SENSOR SELECTION ================= */
 
    let reps, source;
    if (gyroReps.length >= accelReps.length && gyroReps.length >= 3) {
        reps = gyroReps;
        source = "GYRO";
    } else {
        reps = accelReps;
        source = "ACCEL";
    }
 
    /* ================= CLASSIFICATION ================= */
 
    let counts = {
        GOOD_BICEP: 0,
        BAD_CURL: 0
    };
 
    const lastRep = reps[reps.length - 1];
    if (!lastRep) return null;
 
    const [s,e] = lastRep;
    const seg = imuBuffer.slice(s,e);
 
    const sd = {
        ax: std(seg.map(d=>d.ax)),
        ay: std(seg.map(d=>d.ay)),
        az: std(seg.map(d=>d.az)),
        gx: std(seg.map(d=>d.gx)),
        gy: std(seg.map(d=>d.gy)),
        gz: std(seg.map(d=>d.gz))
    };
 
    let best = { label:"UNKNOWN", dist:Infinity };
 
    for (const k in REFERENCE_SD) {
        const ref = REFERENCE_SD[k];
        const d = Math.sqrt(
            Object.keys(sd)
                .map(x => (sd[x]-ref[x])**2)
                .reduce((a,b)=>a+b,0)
        );
        if (d < best.dist) best = { label:k, dist:d };
    }
 
    const rawLabel = best.dist > MAX_CLASS_DIST ? "UNKNOWN" : best.label;
    const finalLabel = rawLabel === "BICEP" ? "GOOD_BICEP" : "BAD_CURL";
    counts[finalLabel]++;
 
    /* ================= OUTPUT ================= */
 
    return {
        source,
        repWindow: [s/fs, e/fs],
        rawLabel,
        finalLabel,
        counts
    };
}