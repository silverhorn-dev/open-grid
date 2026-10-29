import { statfsSync, statSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// ================= AUSLASTUNG (Admin-Panel, Board T25) =================
// Alle 10 s eine Messung; die letzte Stunde in 10-s-Schritten, die letzten 24 h als Minutenwerte
// (Mittel bzw. Hoechstwert der sechs Messungen). Nur im Speicher, nach einem Neustart leer.
// Gemessen wird nur Technisches: Prozess (CPU, Speicher, Event Loop), System (Last, Speicher, Platte),
// Verbindungen, Anfragen, Warteschlange. Keine Inhalte, keine IDs.
export const METRIC_KEYS = [
    'cpu', 'memory', 'systemMemory', 'load', 'eventLoopMs', 'sockets', 'peersOnline',
    'requestsPerSecond', 'errorsPerSecond', 'responseMs', 'queueMessages', 'queueBytes', 'diskFreeBytes', 'databaseBytes'
];
// Hoechstwert statt Mittel bei der Minuten-Verdichtung (Spitzen sollen sichtbar bleiben).
const PEAK_KEYS = new Set(['eventLoopMs', 'responseMs', 'errorsPerSecond']);
const SAMPLE_MS = 10_000;
const LIVE_SAMPLES = 360;
const DAY_SAMPLES = 1440;

export function createMetrics({ store, signaling, databasePath, dataDirectory, intervalMs = SAMPLE_MS, now = Date.now }) {
    const live = [];
    const day = [];
    const delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    let requests = 0;
    let errors = 0;
    let responseTotal = 0;
    let lastCpu = process.cpuUsage();
    let lastAt = now();
    let pendingMinute = [];
    const cores = Math.max(1, cpus().length);

    function size(path) {
        try {
            return statSync(path).size;
        } catch {
            return 0;
        }
    }

    function sample() {
        const at = now();
        const elapsedMs = Math.max(1, at - lastAt);
        const cpu = process.cpuUsage(lastCpu);
        lastCpu = process.cpuUsage();
        lastAt = at;
        let diskFreeBytes = null;
        try {
            const disk = statfsSync(dataDirectory);
            diskFreeBytes = disk.bavail * disk.bsize;
        } catch {
            diskFreeBytes = null;
        }
        const queue = store.admin.queueTotals(at);
        const memory = process.memoryUsage();
        const point = {
            at,
            // Anteil an der ganzen Maschine (alle Kerne = 100 %).
            cpu: Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs / cores) * 1000) / 10,
            memory: memory.rss,
            systemMemory: Math.round((1 - freemem() / totalmem()) * 1000) / 10,
            load: Math.round(loadavg()[0] * 100) / 100,
            eventLoopMs: Math.round(delay.percentile(99) / 1e4) / 100,
            sockets: signaling?.socketCount?.() ?? 0,
            peersOnline: signaling?.onlineCount?.() ?? 0,
            requestsPerSecond: Math.round((requests / elapsedMs) * 1e5) / 100,
            errorsPerSecond: Math.round((errors / elapsedMs) * 1e5) / 100,
            responseMs: requests ? Math.round((responseTotal / requests) * 10) / 10 : 0,
            queueMessages: queue.count,
            queueBytes: queue.bytes,
            diskFreeBytes,
            databaseBytes: databasePath === ':memory:' ? 0 : size(databasePath) + size(`${databasePath}-wal`)
        };
        delay.reset();
        requests = 0;
        errors = 0;
        responseTotal = 0;
        live.push(point);
        if (live.length > LIVE_SAMPLES) live.shift();
        pendingMinute.push(point);
        if (pendingMinute.length >= Math.round(60_000 / intervalMs)) {
            day.push(aggregate(pendingMinute));
            if (day.length > DAY_SAMPLES) day.shift();
            pendingMinute = [];
        }
        return point;
    }

    function aggregate(points) {
        const result = { at: points.at(-1).at };
        for (const key of METRIC_KEYS) {
            const values = points.map(point => point[key]).filter(value => typeof value === 'number');
            if (!values.length) result[key] = null;
            else result[key] = PEAK_KEYS.has(key) ? Math.max(...values) : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
        }
        return result;
    }

    let timer = null;
    return {
        // Aus dem onResponse-Hook: Dauer in ms und Statuscode.
        recordResponse(statusCode, durationMs) {
            requests += 1;
            responseTotal += durationMs;
            if (statusCode >= 500) errors += 1;
        },
        sample,
        start() {
            if (timer) return;
            sample();
            timer = setInterval(sample, intervalMs);
            timer.unref?.();
        },
        stop() {
            clearInterval(timer);
            timer = null;
            delay.disable();
        },
        series(range = '1h') {
            return { range, intervalMs: range === '24h' ? 60_000 : intervalMs, points: range === '24h' ? [...day, ...(pendingMinute.length ? [aggregate(pendingMinute)] : [])] : [...live] };
        },
        latest: () => live.at(-1) || null,
        system: () => ({ cores, totalMemory: totalmem(), uptimeSeconds: Math.round(process.uptime()), node: process.version })
    };
}
