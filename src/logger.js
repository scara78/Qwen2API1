import { appendFileSync, existsSync, mkdirSync, readFileSync, openSync, fstatSync, readSync, closeSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = resolve(__dirname, '..', 'data');
const LOG_FILE = resolve(LOGS_DIR, 'system.log');

// Ensure data directory exists
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

export function logInfo(message) {
  const line = `[${new Date().toISOString()}] [INFO] ${message}\n`;
  try {
    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch (err) {
    console.error('[LOGGER] Write failed:', err.message);
  }
  console.log(line.trim());
}

export function logWarn(message) {
  const line = `[${new Date().toISOString()}] [WARN] ${message}\n`;
  try {
    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch (err) {
    console.error('[LOGGER] Write failed:', err.message);
  }
  console.warn(line.trim());
}

export function logError(message) {
  const line = `[${new Date().toISOString()}] [ERROR] ${message}\n`;
  try {
    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch (err) {
    console.error('[LOGGER] Write failed:', err.message);
  }
  console.error(line.trim());
}

export function readSystemLogs(maxLines = 150) {
  if (!existsSync(LOG_FILE)) return [];
  try {
    const data = readFileSync(LOG_FILE, 'utf-8');
    const lines = data.split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  } catch (err) {
    return [`[ERROR] Failed to read system.log: ${err.message}`];
  }
}

export function readSystemLogsPaginated(page = 1, limit = 100) {
  if (!existsSync(LOG_FILE)) {
    return { logs: [], totalLines: 0, totalPages: 0, page, limit };
  }
  
  let fd;
  try {
    fd = openSync(LOG_FILE, 'r');
    const stat = fstatSync(fd);
    const fileSize = stat.size;
    
    if (fileSize === 0) {
      closeSync(fd);
      return { logs: [], totalLines: 0, totalPages: 0, page, limit };
    }
    
    // Count total lines first by reading chunks and counting newlines
    let totalLines = 0;
    let position = 0;
    const countBuffer = Buffer.alloc(65536); // 64KB chunks for speed
    
    while (position < fileSize) {
      const readLength = Math.min(fileSize - position, countBuffer.length);
      readSync(fd, countBuffer, 0, readLength, position);
      for (let i = 0; i < readLength; i++) {
        if (countBuffer[i] === 10) { // '\n' is ASCII 10
          totalLines++;
        }
      }
      position += readLength;
    }
    
    // If the file does not end with a newline but is not empty, count the last line
    if (fileSize > 0) {
      const lastCharBuffer = Buffer.alloc(1);
      readSync(fd, lastCharBuffer, 0, 1, fileSize - 1);
      if (lastCharBuffer[0] !== 10) {
        totalLines++;
      }
    }
    
    const totalPages = Math.max(1, Math.ceil(totalLines / limit));
    const targetEndLine = totalLines - (page - 1) * limit;
    const targetStartLine = Math.max(0, totalLines - page * limit);
    
    if (targetEndLine <= 0 || targetStartLine >= totalLines) {
      closeSync(fd);
      return { logs: [], totalLines, totalPages, page, limit };
    }
    
    // Now we do a fast backward seek to extract the lines in range [targetStartLine, targetEndLine - 1]
    let readPos = fileSize;
    let buffer = Buffer.alloc(16384);
    let leftover = '';
    let collectedLines = [];
    let currentLineIndex = totalLines; // index of the line that starts after the next \n
    let isAtEnd = true;
    
    while (readPos > 0 && collectedLines.length < (targetEndLine - targetStartLine)) {
      const readLen = Math.min(readPos, buffer.length);
      readPos -= readLen;
      readSync(fd, buffer, 0, readLen, readPos);
      
      const chunkStr = buffer.toString('utf8', 0, readLen) + leftover;
      let partLines = chunkStr.split('\n');
      
      if (isAtEnd && chunkStr.endsWith('\n')) {
        partLines.pop(); // Remove trailing empty element representing end of file
      }
      isAtEnd = false;
      
      leftover = partLines.shift(); // partLines[0] could be partial, save as leftover
      
      // partLines are in chronological order. Iterate backward.
      for (let i = partLines.length - 1; i >= 0; i--) {
        const line = partLines[i].trim();
        currentLineIndex--;
        if (currentLineIndex >= targetStartLine && currentLineIndex < targetEndLine) {
          if (line) collectedLines.push(line);
        }
      }
    }
    
    if (leftover.trim() && currentLineIndex > 0) {
      currentLineIndex--;
      if (currentLineIndex >= targetStartLine && currentLineIndex < targetEndLine) {
        collectedLines.push(leftover.trim());
      }
    }
    
    closeSync(fd);
    
    // collectedLines is in reverse chronological order.
    // We reverse it to return in natural chronological order for the page.
    collectedLines.reverse();
    
    return {
      logs: collectedLines,
      totalLines,
      totalPages,
      page,
      limit
    };
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    throw err;
  }
}
