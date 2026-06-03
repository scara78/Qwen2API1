import { acquireToken } from './auth.js';

const MAX_QUEUE_SIZE = 100;
const queue = [];

export function enqueueRequest(timeoutMs = 30000, excludeEmails = [], signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('Request aborted by client prior to slot allocation'));
    }

    const timer = setTimeout(() => {
      const idx = queue.findIndex(e => e.resolve === resolve);
      if (idx !== -1) queue.splice(idx, 1);
      reject(new Error('Request timed out waiting for available token'));
    }, timeoutMs);

    const abortHandler = () => {
      clearTimeout(timer);
      const idx = queue.findIndex(e => e.resolve === resolve);
      if (idx !== -1) queue.splice(idx, 1);
      reject(new Error('Request aborted by client'));
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler);
    }

    const slot = acquireToken(excludeEmails);
    if (slot) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortHandler);
      resolve(slot);
      return;
    }

    if (queue.length >= MAX_QUEUE_SIZE) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortHandler);
      reject(new Error('Too many queued requests'));
      return;
    }

    queue.push({
      excludeEmails,
      resolve: (slot) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortHandler);
        resolve(slot);
      },
      reject: (err) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', abortHandler);
        reject(err);
      }
    });
  });
}

export function dispatchQueued() {
  while (queue.length > 0) {
    const next = queue[0];
    const slot = acquireToken(next.excludeEmails || []);
    if (!slot) break;
    queue.shift();
    next.resolve(slot);
  }
}

export function getQueueInfo() {
  return { queued: queue.length, maxQueueSize: MAX_QUEUE_SIZE };
}
