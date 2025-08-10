const path = require('path');
const fs = require('fs');
const express = require('express');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const { runMaestro } = require('./test-maestro-runner');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

const PORT = process.env.PORT || 5055;
const jobs = new Map();

// Root endpoint
app.get('/', (_, res) => {
  res.type('html').send(`
    <html>
      <head><title>AI Tester Server (Simple)</title></head>
      <body>
        <h1>AI Tester Server - Real-time Maestro Runner</h1>
        <p>Server is running with real-time test monitoring.</p>
        <ul>
          <li>POST <code>/api/run</code> - Run Maestro test (returns complete results)</li>
          <li>GET <code>/api/jobs/:jobId</code> - Get job details</li>
          <li>GET <code>/api/health</code> - Health check</li>
        </ul>
      </body>
    </html>
  `);
});

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Run Maestro test with real-time monitoring
app.post('/api/run', async (req, res) => {
  const { fileName } = req.body || {};
  
  if (!fileName) {
    return res.status(400).json({ error: 'fileName is required' });
  }

  if (!fs.existsSync(fileName)) {
    return res.status(404).json({ error: 'file not found' });
  }

  const jobId = uuidv4();
  const job = {
    id: jobId,
    status: 'running',
    fileName,
    startedAt: new Date().toISOString(),
    result: null,
    error: null
  };

  jobs.set(jobId, job);

  // Run Maestro test in background
  runMaestroJob(job).catch(() => {});

  // Return immediately with job ID
  return res.json({ 
    ok: true, 
    message: 'Maestro test started with real-time monitoring', 
    jobId: job.id 
  });
});

// Get job details
app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  return res.json(job);
});

// Wait for job completion (blocking)
app.get('/api/jobs/:jobId/wait', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  
  const timeout = parseInt(req.query.timeout) || 60000; // 60s default
  const startTime = Date.now();
  
  const checkCompletion = () => {
    const currentJob = jobs.get(req.params.jobId);
    const isComplete = currentJob.status === 'completed' || currentJob.status === 'failed';
    
    if (isComplete) {
      return res.json({
        jobId: currentJob.id,
        status: currentJob.status,
        isComplete: true,
        result: currentJob.result,
        completedAt: currentJob.completedAt
      });
    }
    
    if (Date.now() - startTime > timeout) {
      return res.status(408).json({ 
        error: 'timeout', 
        jobId: currentJob.id,
        status: currentJob.status,
        isComplete: false 
      });
    }
    
    setTimeout(checkCompletion, 500);
  };
  
  checkCompletion();
});

// Run Maestro job with our new real-time runner
async function runMaestroJob(job) {
  try {
    console.log(`[simple-server] Starting job ${job.id} for file: ${job.fileName}`);
    
    const result = await runMaestro(job.fileName, {
      timeout: 60000, // 60 second timeout
      pollInterval: 1000 // Check every second
    });

    // Update job with results
    job.status = result.success ? 'completed' : 'failed';
    job.result = result;
    job.completedAt = new Date().toISOString();
    jobs.set(job.id, job);

    console.log(`[simple-server] Job ${job.id} ${result.success ? 'completed' : 'failed'}`);
    console.log(`[simple-server] Flow: ${result.flowName}, Steps: ✅${result.passed} ❌${result.failed} 🔲${result.skipped}`);

  } catch (error) {
    console.error(`[simple-server] Job ${job.id} error:`, error.message);
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    jobs.set(job.id, job);
  }
}

app.listen(PORT, () => {
  console.log(`[simple-server] Real-time Maestro server listening on http://localhost:${PORT}`);
  console.log('[simple-server] Features:');
  console.log('  ✅ Real-time test monitoring');
  console.log('  ✅ Complete results in single API call');
  console.log('  ✅ Progress tracking every 1 second');
  console.log('  ✅ Accurate step counting');
});

module.exports = app;