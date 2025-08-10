∫const path = require('path');
const fs = require('fs');
const express = require('express');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const OpenAI = require('openai');

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

// OpenAI configuration (lazy initialization)
let openai = null;
function getOpenAI() {
  if (!openai && process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openai;
}

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

async function analyzeFailureWithAI(job) {
  if (!process.env.OPENAI_API_KEY) {
    console.log('[ai-tester] OpenAI API key not configured, skipping AI analysis');
    return null;
  }

  try {
    const { result, flowPath } = job;
    const flowContent = fs.existsSync(flowPath) ? fs.readFileSync(flowPath, 'utf8') : 'Flow file not found';
    
    const prompt = `You are reviewing test results and something failed. Based on the results, create a short list of tasks for the dev to fix it.

**Test Flow File:**
\`\`\`yaml
${flowContent}
\`\`\`

**Test Results:**
- Flow Name: ${result?.parsed?.flowName || 'Unknown'}
- Exit Code: ${result?.exitCode || 'Unknown'}
- Passed Steps: ${result?.parsed?.passedSteps || 0}
- Failed Steps: ${result?.parsed?.failedSteps || 0}
- Skipped Steps: ${result?.parsed?.skippedSteps || 0}

**Error Details:**
${result?.parsed?.errorMessage || 'No specific error message'}

**Raw Output:**
\`\`\`
${result?.stdout || 'No stdout'}
\`\`\`

Please provide a concise list of actionable tasks for the developer to fix this issue.`;

    console.log('[ai-tester] Analyzing failure with OpenAI...');
    const openaiClient = getOpenAI();
    if (!openaiClient) {
      throw new Error('OpenAI client not initialized');
    }
    
    const completion = await openaiClient.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful QA engineer analyzing test failures. Provide clear, actionable tasks for developers.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 500,
      temperature: 0.3
    });

    const analysis = completion.choices[0]?.message?.content;
    console.log('[ai-tester] AI Analysis completed');
    return analysis;

  } catch (error) {
    console.error('[ai-tester] OpenAI analysis failed:', error.message);
    return null;
  }
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

// 2) Run Maestro for a generated flow or direct file
// POST /api/run
// Body: { jobId?: string, fileName?: string }
app.post('/api/run', async (req, res) => {
  const { jobId, fileName } = req.body || {};
  
  let job;
  
  if (fileName) {
    // Direct file execution - create a minimal job
    if (!fs.existsSync(fileName)) {
      return res.status(404).json({ error: 'file not found' });
    }
    
    const newJobId = uuidv4();
    job = {
      id: newJobId,
      status: 'generated',
      createdAt: new Date().toISOString(),
      flowPath: fileName,
      cursorTask: null,
      flow: { title: path.basename(fileName), steps: [] },
      result: null,
      error: null,
    };
    jobs.set(newJobId, job);
  } else if (jobId) {
    // Existing job execution
    job = jobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    if (!job.flowPath) return res.status(400).json({ error: 'flow not generated' });
  } else {
    return res.status(400).json({ error: 'either jobId or fileName is required' });
  }

  // Run maestro test in background and return immediately
  runMaestro(job).catch(() => {});
  return res.json({ ok: true, message: 'Maestro started', jobId: job.id });
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

// Check if job is complete (non-blocking)
app.get('/api/jobs/:jobId/status', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  
  const isComplete = job.status === 'passed' || job.status === 'failed';
  return res.json({ 
    jobId: job.id,
    status: job.status, 
    isComplete,
    ...(isComplete && { 
      result: job.result?.parsed,
      completedAt: job.completedAt 
    })
  });
});

// Wait for job completion (blocking with timeout)
app.get('/api/jobs/:jobId/wait', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  
  const timeout = parseInt(req.query.timeout) || 30000; // 30s default
  const startTime = Date.now();
  
  const checkCompletion = () => {
    const currentJob = jobs.get(req.params.jobId);
    const isComplete = currentJob.status === 'passed' || currentJob.status === 'failed';
    
    if (isComplete) {
      return res.json({
        jobId: currentJob.id,
        status: currentJob.status,
        isComplete: true,
        result: currentJob.result?.parsed,
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
    
    setTimeout(checkCompletion, 500); // Check every 500ms
  };
  
  checkCompletion();
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

function parseMaestroOutput(stdout, stderr, exitCode) {
  const output = stdout + stderr;
  const success = exitCode === 0;
  
  // Parse flow name - look for "Flow: name" or "Flow name" patterns
  let flowName = 'Unknown';
  const flowMatch = output.match(/> Flow[:\s]+(.+)/i);
  if (flowMatch) {
    flowName = flowMatch[1].trim();
  }
  
  // Count steps by analyzing the step execution logs
  let passedSteps = 0;
  let failedSteps = 0;
  let skippedSteps = 0;
  
  // Split into lines and analyze each step
  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Look for step completion patterns
    if (trimmed.includes('COMPLETED')) {
      passedSteps++;
    } else if (trimmed.includes('FAILED')) {
      failedSteps++;
    }
    // Note: SKIPPED steps might not appear in our stdout format
  }
  
  // Alternative: count from the formatted summary if it exists (fallback)
  const flowSectionMatch = output.match(/║[\s\S]*?║/);
  if (flowSectionMatch) {
    const flowSection = flowSectionMatch[0];
    const summaryPassed = (flowSection.match(/✅/g) || []).length;
    const summaryFailed = (flowSection.match(/❌/g) || []).length;
    const summarySkipped = (flowSection.match(/🔲/g) || []).length;
    
    // Use summary counts if they're higher (more accurate)
    if (summaryPassed > 0 || summaryFailed > 0 || summarySkipped > 0) {
      passedSteps = summaryPassed;
      failedSteps = summaryFailed;
      skippedSteps = summarySkipped;
    }
  }
  
  // Extract error message if failed
  let errorMessage = '';
  if (!success) {
    // Look for error messages after "Element not found" or similar patterns
    const errorStartIndex = lines.findIndex(line => 
      line.includes('Element not found') || 
      line.includes('FAILED') ||
      line.includes('not found')
    );
    
    if (errorStartIndex >= 0) {
      // Get the error message and a few context lines
      const errorLines = lines.slice(errorStartIndex, errorStartIndex + 3)
        .filter(line => line.trim() && !line.includes('===='))
        .map(line => line.trim());
      errorMessage = errorLines.join(' ').trim();
    }
  }
  
  return {
    success,
    flowName,
    passedSteps,
    failedSteps,
    skippedSteps,
    errorMessage,
    exitCode
  };
}

function runMaestro(job) {
  return new Promise((resolve) => {
    job.status = 'running';
    jobs.set(job.id, job);

    const args = ['test', job.flowPath];
    console.log(`[ai-tester] Running: ${MAESTRO_BIN} ${args.join(' ')}`);
    
    const child = spawn(MAESTRO_BIN, args, {
      cwd: MAESTRO_WORKSPACE,
      shell: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const data = d.toString();
      stdout += data;
      console.log(`[maestro-stdout] ${data.trim()}`);
    });
    
    child.stderr.on('data', (d) => {
      const data = d.toString();
      stderr += data;
      console.log(`[maestro-stderr] ${data.trim()}`);
    });
    
    child.on('close', async (code) => {
      console.log(`[ai-tester] Maestro finished with exit code: ${code}`);
      
      const parsed = parseMaestroOutput(stdout, stderr, code);
      const success = parsed.success;
      
      job.status = success ? 'passed' : 'failed';
      job.completedAt = new Date().toISOString();
      job.result = { 
        success, 
        code, 
        stdout, 
        stderr,
        parsed
      };
      jobs.set(job.id, job);

      // Notify MCP based on results
      if (success) {
        console.log(`[ai-tester] ✅ Flow "${parsed.flowName}" passed (${parsed.passedSteps} steps)`);
        await notifyMcp({
          type: 'maestro_ok',
          jobId: job.id,
          message: `All checks passed for flow "${parsed.flowName}"`,
          stats: { passed: parsed.passedSteps, failed: parsed.failedSteps, skipped: parsed.skippedSteps },
          cursorTask: job.cursorTask
        });
      } else {
        console.log(`[ai-tester] ❌ Flow "${parsed.flowName}" failed (${parsed.passedSteps} passed, ${parsed.failedSteps} failed)`);
        console.log(`[ai-tester] Error: ${parsed.errorMessage}`);
        
        // Get AI analysis for failed tests
        const aiAnalysis = await analyzeFailureWithAI(job);
        
        // Update job with AI analysis
        if (aiAnalysis) {
          job.result.aiAnalysis = aiAnalysis;
          jobs.set(job.id, job);
        }
        
        await notifyMcp({
          type: 'maestro_failed',
          jobId: job.id,
          message: `Flow "${parsed.flowName}" failed`,
          error: parsed.errorMessage,
          stats: { passed: parsed.passedSteps, failed: parsed.failedSteps, skipped: parsed.skippedSteps },
          aiAnalysis: aiAnalysis,
          cursorTask: job.cursorTask
        });
      }

      resolve();
    });
    
    child.on('error', (error) => {
      console.error(`[ai-tester] Failed to start Maestro: ${error.message}`);
      job.status = 'failed';
      job.error = error.message;
      jobs.set(job.id, job);
      resolve();
    });
  });
}

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[ai-tester] Server listening on http://localhost:${PORT}`);
});

