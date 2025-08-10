import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

export interface ModifiedFile {
  path: string;
  diff?: string;
}

export interface GenerateUnitTestsParams {
  userMessage: string;
  modifiedFiles?: ModifiedFile[];
  relatedFiles?: string[];
  count?: number;
  model?: string;
  verbosity?: 'low' | 'medium' | 'high';
  minimalReasoning?: boolean;
}

export interface GenerateUnitTestsResult {
  tests: string[];
  meta?: Record<string, unknown>;
}

const DEFAULT_MODEL = process.env.GEN_UNIT_TESTS_MODEL || 'gpt-5-mini';

function repoRootDir(): string {
  // Resolve repo root as the parent of the server directory
  const __filename = fileURLToPath(import.meta.url);
  const serverSrcDir = path.dirname(__filename);
  const serverDir = path.resolve(serverSrcDir, '..');
  const root = path.resolve(serverDir, '..');
  return root;
}

function readGrammar(): string {
  const root = repoRootDir();
  const candidates = [
    path.join(root, 'TestGen', 'maestro_grammar.lark'),
    path.join(process.cwd(), 'TestGen', 'maestro_grammar.lark'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch (_) {
      // ignore
    }
  }
  throw new Error('maestro_grammar.lark not found in TestGen directory');
}

function truncate(text: string, limit = 8000): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit / 2));
  const tail = text.slice(-Math.floor(limit / 2));
  return `${head}\n... <truncated> ...\n${tail}`;
}

function buildPrompt(
  userMessage: string,
  changedFiles: string[],
  relatedFiles: string[],
  changedDiffs: Record<string, string>,
  relatedFileBodies: Record<string, string>
): string {
  const changedList = changedFiles.length
    ? changedFiles.map((p) => `- ${p}`).join('\n')
    : '- (none)';
  const relatedList = relatedFiles.length
    ? relatedFiles.map((p) => `- ${p}`).join('\n')
    : '- (none)';

  const examples = [
    'appId: "com.example.app"',
    '---',
    '- tapOn: "Login"',
    '- inputText: "username"',
    '- inputText: "password"',
    '- assertVisible: "Welcome"',
    '',
    '- tapOn:',
    '  id: "login_button"',
  ].join('\n');

  const parts: string[] = [];
  parts.push(
    'Call the maestro_yaml_grammar tool to generate ONE Maestro YAML test flow. ' +
      'Strictly conform to the grammar. Use DOUBLE QUOTES for all strings. ' +
      "Do NOT emit 'tapOn:' without an immediate indented line containing either 'id:' or 'text:'.\n"
  );
  parts.push(`\nUser message:\n${userMessage}\n`);
  parts.push(`\nChanged files (paths):\n${changedList}\n`);

  if (Object.keys(changedDiffs).length) {
    parts.push('\nChanged file diffs (for context only):\n');
    for (const [p, diff] of Object.entries(changedDiffs)) {
      parts.push(`\n# DIFF: ${p}\n` + truncate(diff));
    }
  }

  parts.push(`\nRelated files (paths):\n${relatedList}\n`);
  if (Object.keys(relatedFileBodies).length) {
    parts.push('\nRelated file contents (for context only):\n');
    for (const [p, body] of Object.entries(relatedFileBodies)) {
      parts.push(`\n# FILE: ${p}\n` + truncate(body));
    }
  }

  parts.push('\nFollow these patterns exactly (indentation and quoting):\n' + examples);
  parts.push(
    '\nCRITICAL FORMATTING RULES:\n' +
      '- Use double-quoted strings for ALL text and file paths.\n' +
      "- Include the appId header and the '---' separator.\n" +
      '- For commands with parameters, choose ONE format:\n' +
      '  * Simple: \"tapOn: \"text\"\" (one line)\n' +
      '  * Map: \"tapOn:\" NEWLINE \"  id: \"...\"\" (2-space indent)\n' +
      "- NEVER use 'tapOn:' alone without immediate content\n" +
      '- takeScreenshot requires map form: \"takeScreenshot:\" NEWLINE \"  name: \"...\"\"\n' +
      "- If using conditions, use 'when:' followed by 4-space indented lines.\n"
  );

  return parts.join('');
}

function extractToolInputFromResponse(response: any): string | null {
  const out = (response as any)?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      if (typeof item?.input === 'string') return item.input;
    }
    const chunks: string[] = [];
    for (const item of out) {
      const content = (item as any)?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === 'string') chunks.push(c.text);
        }
      }
    }
    if (chunks.length) return chunks.join('');
  }
  // Fallbacks if SDK shape differs
  if (typeof (response as any)?.input === 'string') return (response as any).input;
  const content = (response as any)?.content;
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const c of content) if (typeof c?.text === 'string') chunks.push(c.text);
    if (chunks.length) return chunks.join('');
  }
  return null;
}

async function generateOne(
  client: OpenAI,
  model: string,
  grammarText: string,
  userMessage: string,
  changedFiles: string[],
  relatedFiles: string[],
  changedDiffs: Record<string, string>,
  relatedBodies: Record<string, string>,
  verbosity: 'low' | 'medium' | 'high',
  minimalReasoning: boolean
): Promise<string> {
  const prompt = buildPrompt(userMessage, changedFiles, relatedFiles, changedDiffs, relatedBodies);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body: any = {
      model,
      input:
        attempt === 0
          ? prompt
          : `${prompt}\n\nCORRECTION: Grammar violation! For mapping commands like 'tapOn:', 'takeScreenshot:', etc:\n- Simple form: 'tapOn: "text"' (one line)\n- Map form: 'tapOn:' then NEWLINE, then '  id: "..."' (indented 2 spaces)\nNEVER mix forms. After a colon in map form, ALWAYS have a newline before the indented properties.`,
      text: { format: { type: 'text' }, verbosity },
      tools: [
        {
          // Cast to any to allow custom grammar tool format across SDK versions
          type: 'custom',
          name: 'maestro_yaml_grammar',
          description:
            'Generates a Maestro YAML test flow. YOU MUST ONLY EMIT STRINGS VALID UNDER THE PROVIDED LARK GRAMMAR.',
          format: {
            type: 'grammar',
            syntax: 'lark',
            definition: grammarText,
          },
        } as any,
      ],
      parallel_tool_calls: false,
      reasoning: { effort: minimalReasoning ? 'low' : 'medium' },
    };
    const response: any = await (client.responses as any).create(body);

    const toolInput = extractToolInputFromResponse(response);
    if (typeof toolInput === 'string' && toolInput.trim().length > 0) {
      return toolInput;
    }
  }
  throw new Error('Failed to generate valid YAML after retries');
}

export async function generateUnitTests(params: GenerateUnitTestsParams): Promise<GenerateUnitTestsResult> {
  const grammarText = readGrammar();

  const {
    userMessage,
    modifiedFiles = [],
    relatedFiles = [],
    count = 3,
    model = DEFAULT_MODEL,
    verbosity = 'low',
    minimalReasoning = false,
  } = params;

  const changedFilesPaths = modifiedFiles.map((m) => m.path);
  const changedDiffs: Record<string, string> = {};
  for (const m of modifiedFiles) if (m.path && typeof m.diff === 'string') changedDiffs[m.path] = m.diff;

  // Read related file bodies (best-effort)
  const relatedBodies: Record<string, string> = {};
  for (const p of relatedFiles) {
    try {
      const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
      relatedBodies[p] = fs.readFileSync(abs, 'utf-8');
    } catch (_) {
      // ignore read errors
    }
  }

  // API key (hardcoded fallback as requested)
  const apiKey =
    process.env.OPENAI_API_KEY ||
    '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';
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const client = new OpenAI({ apiKey });

  const tests: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const unit = await generateOne(
      client,
      model,
      grammarText,
      userMessage,
      changedFilesPaths,
      relatedFiles,
      changedDiffs,
      relatedBodies,
      verbosity,
      minimalReasoning
    );
    tests.push(unit);
  }

  return { tests, meta: { generated: tests.length } };
}

// Back-compat wrapper used by index.ts
export interface JobRecordLike {
  id: string;
  modification: {
    userMessage: string;
    modifiedFiles: { path: string; diff: string }[];
    relatedFiles: string[];
  } | null;
}

export async function generateMaestroScripts(record: JobRecordLike): Promise<string[]> {
  if (!record.modification) return [];
  const { userMessage, modifiedFiles, relatedFiles } = record.modification;
  const result = await generateUnitTests({ userMessage, modifiedFiles, relatedFiles, count: 3 });
  return result.tests;
}