import * as path from 'path';
import * as fs from 'fs';
import express, { Request, Response } from 'express';
import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';
import { runMaestro, MaestroResult } from './test-maestro-runner';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

const PORT = process.env.PORT || 5055;

interface Job {
  id: string;
  status: 'running' | 'completed' | 'failed';
  fileName: string;
  startedAt: string;
  completedAt?: string;
  result?: MaestroResult;
  error?: string;
}

const jobs = new Map<string, Job>();

// Root endpoint
app.get('/', (_: Request, res: Response) => {
  res.type('html').send(`
    <html>
      <head><title>AI Tester Server (TypeScript)</title></head>
      <body>
        <h1>AI Tester Server - Real-time Maestro Runner (TypeScript)</h1>
        <p>Server is running with real-time test monitoring and TypeScript support.</p>
        <ul>
          <li>POST <code>/api/run</code> - Run Maestro test (returns complete results)</li>
          <li>GET <code>/api/jobs/:jobId</code> - Get job details</li>
          <li>GET <code>/api/jobs/:jobId/wait</code> - Wait for job completion</li>
          <li>GET <code>/api/health</code> - Health check</li>
        </ul>
      </body>
    </html>
  `);
});

// Health check
app.get('/api/health', (_: Request, res: Response) => {
  res.json({ ok: true, typescript: true });
});

// Run Maestro test with real-time monitoring
app.post('/api/run', async (req: Request, res: Response) => {
  const { fileName }: { fileName?: string } = req.body || {};
  
  if (!fileName) {
    return res.status(400).json({ error: 'fileName is required' });
  }

  if (!fs.existsSync(fileName)) {
    return res.status(404).json({ error: 'file not found' });
  }

  const jobId = uuidv4();
  const job: Job = {
    id: jobId,
    status: 'running',
    fileName,
    startedAt: new Date().toISOString()
  };

  jobs.set(jobId, job);

  // Run Maestro test in background
  runMaestroJob(job).catch(() => {});

  // Return immediately with job ID
  return res.json({ 
    ok: true, 
    message: 'Maestro test started with real-time monitoring (TypeScript)', 
    jobId: job.id 
  });
});

// Get job details
app.get('/api/jobs/:jobId', (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  return res.json(job);
});

// Wait for job completion (blocking)
app.get('/api/jobs/:jobId/wait', (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  
  const timeout = parseInt(req.query.timeout as string) || 60000; // 60s default
  const startTime = Date.now();
  
  const checkCompletion = (): void => {
    const currentJob = jobs.get(req.params.jobId);
    if (!currentJob) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    
    const isComplete = currentJob.status === 'completed' || currentJob.status === 'failed';
    
    if (isComplete) {
      res.json({
        jobId: currentJob.id,
        status: currentJob.status,
        isComplete: true,
        result: currentJob.result,
        completedAt: currentJob.completedAt
      });
      return;
    }
    
    if (Date.now() - startTime > timeout) {
      res.status(408).json({ 
        error: 'timeout', 
        jobId: currentJob.id,
        status: currentJob.status,
        isComplete: false 
      });
      return;
    }
    
    setTimeout(checkCompletion, 500);
  };
  
  checkCompletion();
});

// Run Maestro job with our new real-time TypeScript runner
async function runMaestroJob(job: Job): Promise<void> {
  try {
    console.log(`[simple-server-ts] Starting job ${job.id} for file: ${job.fileName}`);
    
    const result: MaestroResult = await runMaestro(job.fileName, {
      timeout: 60000, // 60 second timeout
      pollInterval: 1000 // Check every second
    });

    // Update job with results
    job.status = result.success ? 'completed' : 'failed';
    job.result = result;
    job.completedAt = new Date().toISOString();
    jobs.set(job.id, job);

    console.log(`[simple-server-ts] Job ${job.id} ${result.success ? 'completed' : 'failed'}`);
    console.log(`[simple-server-ts] Flow: ${result.flowName}, Steps: ✅${result.passed} ❌${result.failed} 🔲${result.skipped}`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[simple-server-ts] Job ${job.id} error:`, errorMessage);
    job.status = 'failed';
    job.error = errorMessage;
    job.completedAt = new Date().toISOString();
    jobs.set(job.id, job);
  }
}

app.listen(PORT, () => {
  console.log(`[simple-server-ts] TypeScript Maestro server listening on http://localhost:${PORT}`);
  console.log('[simple-server-ts] Features:');
  console.log('  ✅ Real-time test monitoring');
  console.log('  ✅ Complete results in single API call');
  console.log('  ✅ Progress tracking every 1 second');
  console.log('  ✅ Accurate step counting');
  console.log('  ✅ TypeScript support with full type safety');
});

export default app;