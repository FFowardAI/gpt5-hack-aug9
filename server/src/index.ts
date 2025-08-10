import path from 'node:path';
import fs from 'node:fs';
import express, { Request, Response } from 'express';
import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { spawn } from 'node:child_process';
import { generateUnitTests } from './maestroGenerator.js';
import { runMultipleMaestroTests, writeMaestroFlows, runMaestro } from './maestroTestRunner.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// In-memory job store (replace with DB if needed)
type JobStatus = 'received' | 'generated' | 'running' | 'passed' | 'failed';

export interface ModifiedFile {
  path: string;
  diff: string;
}

export interface GenerateRequestBody {
  userMessage: string;
  modifiedFiles: ModifiedFile[];
  relatedFiles: string[];
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: string;
  flowPath: string | null;
  cursorTask: null; // reserved for future use
  modification: GenerateRequestBody | null;
  flow: null; // reserved for future use
  result: any;
  error: any;
  completedAt?: string;
}

const jobs = new Map<string, JobRecord>();

// Config via env
const PORT = Number(process.env.PORT || 5055);
const MAESTRO_BIN = process.env.MAESTRO_BIN || 'maestro';
const MAESTRO_WORKSPACE = process.env.MAESTRO_WORKSPACE || path.resolve(process.cwd());
const MAESTRO_FLOW_DIR = process.env.MAESTRO_FLOW_DIR || path.join(MAESTRO_WORKSPACE, 'maestro-flows');
const MCP_WEBHOOK_URL = process.env.MCP_WEBHOOK_URL || '';

function ensureDirExists(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDirExists(MAESTRO_FLOW_DIR);

async function notifyMcp(payload: unknown) {
  if (!MCP_WEBHOOK_URL) return { skipped: true } as const;
  try {
    const res = await axios.post(MCP_WEBHOOK_URL, payload, { timeout: 10_000 });
    return { ok: true as const, status: res.status };
  } catch (error: any) {
    return { ok: false as const, error: error?.message ?? String(error) };
  }
}

// 1) Receive modification context for test generation
// POST /api/generate
// Body: GenerateRequestBody
app.post('/api/generate-tests', async (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<GenerateRequestBody> | undefined;
    const userMessage = body?.userMessage;
    const modifiedFiles = body?.modifiedFiles;
    const relatedFiles = body?.relatedFiles;

    if (typeof userMessage !== 'string' || userMessage.length === 0) {
      return res.status(400).json({ error: 'userMessage must be a non-empty string' });
    }
    if (!Array.isArray(modifiedFiles)) {
      return res.status(400).json({ error: 'modifiedFiles must be an array' });
    }
    for (const mf of modifiedFiles) {
      if (!mf || typeof mf.path !== 'string' || typeof mf.diff !== 'string') {
        return res.status(400).json({ error: 'each modifiedFiles item must be an object with string path and diff' });
      }
    }
    if (!Array.isArray(relatedFiles) || relatedFiles.some((r) => typeof r !== 'string')) {
      return res.status(400).json({ error: 'relatedFiles must be an array of strings' });
    }

    const jobId = uuidv4();

    const record: JobRecord = {
      id: jobId,
      status: 'received',
      createdAt: new Date().toISOString(),
      flowPath: null,
      cursorTask: null,
      modification: { userMessage, modifiedFiles, relatedFiles } as GenerateRequestBody,
      flow: null,
      result: null,
      error: null,
    };

    console.log('received modification context', JSON.stringify(record, null, 2));

    // Generate Maestro tests using the new TS generator
    const generatedTests = await generateUnitTests({
      userMessage,
      modifiedFiles,
      relatedFiles,
      count: 3,
    });

    console.log('generated tests', generatedTests);

    // Persist generated tests to YAML files
    const flowFilePaths = writeMaestroFlows(generatedTests.tests, {
      directory: MAESTRO_FLOW_DIR,
      jobId,
    });

    // Run Maestro on each generated test sequentially
    const runResults = await runMultipleMaestroTests(flowFilePaths, {
      maestroBin: MAESTRO_BIN,
      workspace: MAESTRO_WORKSPACE,
      streamOutput: true,
    });

    const responsePayload = {
      jobId,
      tests: generatedTests.tests,
      files: flowFilePaths,
      results: runResults,
      meta: generatedTests.meta ?? { generated: generatedTests.tests.length },
    };

    jobs.set(jobId, { ...record, status: 'generated', result: responsePayload });
    return res.json(responsePayload);
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? String(error) });
  }
});

app.get('/api/health', (_: Request, res: Response) => res.json({ ok: true }));

// Simple route to manually run a specific Maestro flow by file name
// Example:
//   curl "http://localhost:${PORT}/api/test-maestrorunner?name=25d35967-7e41-44fa-b2f7-20ef01e9af25-1.yml"
app.get('/api/test-maestrorunner', async (req: Request, res: Response) => {
  try {
    const name = (req.query.name || req.query.file || '25d35967-7e41-44fa-b2f7-20ef01e9af25-1.yml') as string;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Query param "name" (or "file") is required' });
    }

    // Force resolution within the configured flows directory
    let candidatePath = path.join(MAESTRO_FLOW_DIR, name);

    // If not found, try toggling between .yml and .yaml
    if (!fs.existsSync(candidatePath)) {
      if (name.toLowerCase().endsWith('.yml')) {
        const alt = name.replace(/\.yml$/i, '.yaml');
        const altPath = path.join(MAESTRO_FLOW_DIR, alt);
        if (fs.existsSync(altPath)) candidatePath = altPath;
      } else if (name.toLowerCase().endsWith('.yaml')) {
        const alt = name.replace(/\.yaml$/i, '.yml');
        const altPath = path.join(MAESTRO_FLOW_DIR, alt);
        if (fs.existsSync(altPath)) candidatePath = altPath;
      }
    }

    if (!fs.existsSync(candidatePath)) {
      return res.status(404).json({ error: 'Flow file not found', tried: [candidatePath] });
    }

    const result = await runMaestro(candidatePath, {
      maestroBin: MAESTRO_BIN,
      workspace: MAESTRO_WORKSPACE,
      streamOutput: true,
    });

    return res.json({ file: candidatePath, result });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? String(error) });
  }
});

app.get('/', (_: Request, res: Response) => {
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

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[ai-tester] Server listening on http://localhost:${PORT}`);
});



