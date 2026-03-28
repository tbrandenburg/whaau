'use strict';

const fs = require('fs');
const path = require('path');

const eventB64 = process.env.EVENT_B64;
const outputFile = process.env.OUTPUT_FILE || '/shared/events.ndjson';

if (!eventB64) {
  console.error('FATAL: EVENT_B64 is not set');
  process.exit(1);
}

let event;
try {
  event = JSON.parse(Buffer.from(eventB64, 'base64').toString('utf8'));
} catch (err) {
  console.error('FATAL: Failed to decode/parse EVENT_B64:', err.message);
  process.exit(1);
}

try {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.appendFileSync(outputFile, JSON.stringify(event) + '\n');
  console.log('Runner: wrote event to', outputFile, '| delivery_id:', event.delivery_id);
} catch (err) {
  console.error('FATAL: Failed to write output file:', err.message);
  process.exit(1);
}
