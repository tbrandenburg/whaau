'use strict';

const express = require('express');
const Dockerode = require('dockerode');

const PORT = process.env.PORT || 8080;
const LAUNCHER_TOKEN = process.env.LAUNCHER_TOKEN;
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || 'local/webhook-runner:latest';
const SHARED_VOLUME_NAME = process.env.SHARED_VOLUME_NAME || 'webhook-shared';
const RUNNER_NETWORK = process.env.RUNNER_NETWORK || 'webhook-internal';

if (!LAUNCHER_TOKEN) {
  console.error('FATAL: LAUNCHER_TOKEN is not set');
  process.exit(1);
}

const docker = new Dockerode();
const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/run', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${LAUNCHER_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'invalid body' });
  }

  const eventB64 = Buffer.from(JSON.stringify(req.body)).toString('base64');
  const deliveryId = req.body.delivery_id || 'unknown';

  console.log(`Launcher: spawning runner for delivery_id=${deliveryId}`);

  try {
    const container = await docker.createContainer({
      Image: RUNNER_IMAGE,
      Env: [
        `EVENT_B64=${eventB64}`,
        `OUTPUT_FILE=/shared/events.ndjson`,
      ],
      HostConfig: {
        AutoRemove: true,
        Binds: [`${SHARED_VOLUME_NAME}:/shared`],
        NetworkMode: RUNNER_NETWORK,
      },
    });

    await container.start();
    console.log(`Launcher: started container ${container.id} for delivery_id=${deliveryId}`);
    return res.status(202).json({ status: 'accepted', container: container.id });
  } catch (err) {
    console.error(`Launcher: failed to start runner for delivery_id=${deliveryId}:`, err.message);
    return res.status(500).json({ error: 'runner launch failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Launcher: listening on port ${PORT}`);
});
