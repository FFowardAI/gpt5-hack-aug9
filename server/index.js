∫const path = require('path');
const fs = require('fs');
const express = require('express');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// In-memory job store (replace with DB if needed)
const jobs = new Map();

// Config via env
const PORT = process.env.PORT || 5055;
const MAESTRO_BIN = process.env.MAESTRO_BIN || 'maestro';
const MAESTRO_WORKSPACE = process.env.MAESTRO_WORKSPACE || path.resolve(process.cwd());
const MAESTRO_FLOW_DIR = process.env.MAESTRO_FLOW_DIR || path.join(MAESTRO_WORKSPACE, 'maestro-flows');
const MCP_WEBHOOK_URL = process.env.MCP_WEBHOOK_URL || ''; // optional

function ensureDirExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDirExists(MAESTRO_FLOW_DIR);

// Helpers
function buildFlowYaml({ title, description, steps }) {
  const header = [
    'appId: com.example.app',
    '---',
    `# ${title || 'Auto-generated Maestro flow'}`,
    ...(description ? [`# ${description}`] : []),
  ].join('\n');
  const stepsYaml = (steps || []).map((s) => `- ${s}`).join('\n');
  return `${header}\n${stepsYaml}\n`;
}

async function notifyMcp(payload) {
  if (!MCP_WEBHOOK_URL) return { skipped: true };
  try {
    const res = await axios.post(MCP_WEBHOOK_URL, payload, { timeout: 10_000 });
    return { ok: true, status: res.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// 1) Generate Maestro test script
// POST /api/generate
// Input body example:
// {
//   "cursorTask": { "instructions": "...", "filesEdited": ["web/src/app/page.tsx"], "context": { ... } },
//   "flow": { "title": "Login Flow", "description": "...", "steps": ["launchApp", "tapOn: 'Login'", "inputText: 'user'", "assertVisible: 'Home'"] }
// }
app.post('/api/generate', async (req, res) => {
  try {
    const { cursorTask, flow } = req.body || {};
    if (!flow || !Array.isArray(flow.steps) || flow.steps.length === 0) {
      return res.status(400).json({ error: 'flow.steps is required and must be non-empty' });
    }

    const jobId = uuidv4();
    const flowFileName = `${jobId}.yaml`;
    const flowPath = path.join(MAESTRO_FLOW_DIR, flowFileName);

    const yaml = buildFlowYaml({
      title: flow.title,
      description: flow.description || (cursorTask ? cursorTask.instructions : ''),
      steps: flow.steps,
    });

    fs.writeFileSync(flowPath, yaml, 'utf8');

    jobs.set(jobId, {
      id: jobId,
      status: 'generated',
      createdAt: new Date().toISOString(),
      flowPath,
      cursorTask: cursorTask || null,
      flow,
      result: null,
      error: null,
    });

    return res.json({ jobId, flowPath });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// 2) Run Maestro for a generated flow
// POST /api/run
// Body: { jobId: string }
app.post('/api/run', async (req, res) => {
  const { jobId } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (!job.flowPath) return res.status(400).json({ error: 'flow not generated' });

  // Run maestro test in background and return immediately
  runMaestro(job).catch(() => {});
  return res.json({ ok: true, message: 'Maestro started' });
});

// 3) Receive Maestro callback (webhook) with result
// POST /api/maestro/callback
// Body example: { jobId: string, success: boolean, summary?: string, details?: object }
app.post('/api/maestro/callback', async (req, res) => {
  try {
    const { jobId, success, summary, details } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });
    const job = jobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });

    job.status = success ? 'passed' : 'failed';
    job.result = { success, summary: summary || '', details: details || null };
    job.completedAt = new Date().toISOString();
    jobs.set(jobId, job);

    // Notify MCP
    const notifyPayload = success
      ? { type: 'maestro_ok', jobId, message: 'All checks passed', cursorTask: job.cursorTask }
      : { type: 'maestro_failed', jobId, message: 'Checks failed', details, cursorTask: job.cursorTask };
    await notifyMcp(notifyPayload);

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Utility endpoints
app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  return res.json(job);
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

// Friendly root route
app.get('/', (_, res) => {
  res.type('html').send(`
    <html>
      <head><title>AI Tester Server</title></head>
      <body>
        <h1>AI Tester Server</h1>
        <p>Server is running.</p>
        <ul>
          <li>GET <code>/api/health</code></li>
          <li>POST <code>/api/generate</code></li>
          <li>POST <code>/api/run</code></li>
          <li>POST <code>/api/maestro/callback</code></li>
        </ul>
      </body>
    </html>
  `);
});

// Run maestro command using child_process
const { spawn } = require('child_process');
function runMaestro(job) {
  return new Promise((resolve) => {
    job.status = 'running';
    jobs.set(job.id, job);

    const args = ['test', job.flowPath];
    const child = spawn(MAESTRO_BIN, args, {
      cwd: MAESTRO_WORKSPACE,
      shell: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', async (code) => {
      const success = code === 0;
      job.status = success ? 'passed' : 'failed';
      job.completedAt = new Date().toISOString();
      job.result = { success, code, stdout, stderr };
      jobs.set(job.id, job);

      // Optionally auto-call our own callback to unify the path
      const details = { code, stdoutTail: stdout.slice(-4000), stderrTail: stderr.slice(-4000) };
      await notifyMcp(
        success
          ? { type: 'maestro_ok', jobId: job.id, message: 'All checks passed', cursorTask: job.cursorTask }
          : { type: 'maestro_failed', jobId: job.id, message: 'Checks failed', details, cursorTask: job.cursorTask }
      );

      resolve();
    });
  });
}

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[ai-tester] Server listening on http://localhost:${PORT}`);
});

