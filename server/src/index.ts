import path from 'node:path';
import fs from 'node:fs';
import express, { Request, Response } from 'express';
import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { spawn } from 'node:child_process';

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
app.post('/api/generate', async (req: Request, res: Response) => {
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
      modification: { userMessage, modifiedFiles, relatedFiles },
      flow: null,
      result: null,
      error: null,
    };

    console.log('received modification context', JSON.stringify(record, null, 2));

    jobs.set(jobId, record);
    return res.json({ jobId, flowPath: null, accepted: true });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? String(error) });
  }
});

app.get('/api/health', (_: Request, res: Response) => res.json({ ok: true }));

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


