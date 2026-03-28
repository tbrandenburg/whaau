'use strict';

const express = require('express');
const { Webhooks } = require('@octokit/webhooks');

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const LAUNCHER_URL = process.env.LAUNCHER_URL;
const LAUNCHER_TOKEN = process.env.LAUNCHER_TOKEN;

if (!WEBHOOK_SECRET || !LAUNCHER_URL || !LAUNCHER_TOKEN) {
  console.error('FATAL: WEBHOOK_SECRET, LAUNCHER_URL, and LAUNCHER_TOKEN must be set');
  process.exit(1);
}

const webhooks = new Webhooks({ secret: WEBHOOK_SECRET });
const app = express();

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// IMPORTANT: raw body required for HMAC verification
app.post('/webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const eventName = req.headers['x-github-event'];
  const deliveryId = req.headers['x-github-delivery'];

  if (!signature || !eventName || !deliveryId) {
    return res.status(400).json({ error: 'missing required github headers' });
  }

  const rawBody = req.body; // Buffer
  const rawBodyStr = rawBody.toString('utf8');
  const isValid = await webhooks.verify(rawBodyStr, signature);

  if (!isValid) {
    console.warn(`Listener: invalid signature for delivery ${deliveryId}`);
    return res.status(401).json({ error: 'invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBodyStr);
  } catch (err) {
    return res.status(400).json({ error: 'invalid json payload' });
  }

  const event = {
    received_at: new Date().toISOString(),
    delivery_id: deliveryId,
    event_name: eventName,
    repository: payload.repository ? payload.repository.full_name : null,
    action: payload.action || null,
    payload,
  };

  console.log(`Listener: accepted delivery_id=${deliveryId} event=${eventName} repo=${event.repository}`);

  try {
    const response = await fetch(LAUNCHER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LAUNCHER_TOKEN}`,
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      console.error(`Listener: launcher returned ${response.status} for delivery_id=${deliveryId}`);
    }
  } catch (err) {
    console.error(`Listener: failed to reach launcher for delivery_id=${deliveryId}:`, err.message);
  }

  return res.status(202).json({ status: 'accepted' });
});

app.listen(PORT, () => {
  console.log(`Listener: listening on port ${PORT}`);
});
