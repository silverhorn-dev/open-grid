// Worker-Thread der Profilbild-Verifizierung (server/verify.js createVerifyRunner): laedt YuNet + SFace beim ersten
// Auftrag und rechnet ausserhalb des Haupt-Threads. Bilder kommen als JPEG-Bytes, zurueck geht nur das Ergebnis.
import { parentPort, workerData } from 'node:worker_threads';
import { loadFaceModels } from './face-verify.js';
import { runCheckJob } from './verify.js';

let models = null;

parentPort.on('message', async ({ id, job }) => {
    try {
        models = models || await loadFaceModels(workerData);
        parentPort.postMessage({ id, result: await runCheckJob(job, models) });
    } catch (error) {
        models = null;
        parentPort.postMessage({ id, error: error.message });
    }
});
