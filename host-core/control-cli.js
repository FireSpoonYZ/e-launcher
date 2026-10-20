import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createControlClient } from './control-client.js';

const USAGE = `usage: node host-core/control-cli.js <host|create|list|get|find-request|send|status|history|abort|context> [options]

commands:
  host             print host info
  create           register a bot; requires --request-id --role --cwd [--model-ref]
  list             print all bot records
  get              print one bot; requires --bot-id
  find-request     print bot by request; requires --request-id
  send             submit a message (accept only, does not wait); requires --bot-id --request-id --text
  status           print one submission; requires --bot-id --request-id
  history          list conversation history; requires --bot-id [--limit] [--cursor]
  abort            abort a bot's current work; requires --bot-id
  context          print context status; requires --bot-id

options:
  --url <url>         host control server URL (required, except --help)
  --token-env <name>  environment variable holding the bearer token (required, except --help)
  --bot-id <id>
  --request-id <id>
  --role <text>
  --cwd <dir>
  --model-ref <value>
  --text <text>
  --limit <int>       strict decimal positive integer (history)
  --cursor <json>     JSON object cursor (history)
  -h, --help          show this help
`;

const OPTIONS = {
  url: { type: 'string' },
  'token-env': { type: 'string' },
  'bot-id': { type: 'string' },
  'request-id': { type: 'string' },
  role: { type: 'string' },
  cwd: { type: 'string' },
  'model-ref': { type: 'string' },
  text: { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const REQUIRED = {
  host: [],
  create: ['request-id', 'role', 'cwd'],
  list: [],
  get: ['bot-id'],
  'find-request': ['request-id'],
  send: ['bot-id', 'request-id', 'text'],
  status: ['bot-id', 'request-id'],
  history: ['bot-id'],
  abort: ['bot-id'],
  context: ['bot-id'],
};

// host/list 不接受任何资源参数。
const RESOURCE_OPTIONS = ['bot-id', 'request-id', 'role', 'cwd', 'model-ref', 'text', 'limit', 'cursor'];

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function parseLimit(value) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw invalid('--limit must be a strict decimal positive integer');
  }
  return Number(value);
}

function parseCursor(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid('--cursor must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('--cursor must be a JSON object');
  }
  return parsed;
}

function tokenFromEnv(name) {
  if (!ENV_NAME_RE.test(name)) {
    throw invalid(`invalid --token-env name: ${name}`);
  }
  const token = process.env[name];
  if (token === undefined || token === '') {
    throw invalid(`environment variable ${name} is not set`);
  }
  return token;
}

async function main() {
  const argv = process.argv.slice(2);
  const hasCommand = argv.length > 0 && !argv[0].startsWith('-');
  const command = hasCommand ? argv[0] : undefined;
  let values;
  try {
    ({ values } = parseArgs({
      args: hasCommand ? argv.slice(1) : argv,
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw invalid(err.message);
  }
  const knownCommand = Object.hasOwn(REQUIRED, command);
  if (values.help) {
    if (command !== undefined && !knownCommand) {
      throw invalid(`unknown command: ${command}`);
    }
    process.stdout.write(USAGE);
    return;
  }
  if (!knownCommand) {
    throw invalid(`unknown command: ${command ?? '(none)'}`);
  }
  if (values.url === undefined) throw invalid('missing required option --url');
  if (values['token-env'] === undefined) throw invalid('missing required option --token-env');
  for (const key of REQUIRED[command]) {
    if (values[key] === undefined) {
      throw invalid(`missing required option --${key}`);
    }
  }
  if (command === 'host' || command === 'list') {
    for (const key of RESOURCE_OPTIONS) {
      if (values[key] !== undefined) {
        throw invalid(`${command} does not take --${key}`);
      }
    }
  }
  const historyOptions = {};
  if (command === 'history') {
    if (values.limit !== undefined) historyOptions.limit = parseLimit(values.limit);
    if (values.cursor !== undefined) historyOptions.cursor = parseCursor(values.cursor);
  }

  const client = createControlClient({ url: values.url, token: tokenFromEnv(values['token-env']) });

  let result;
  switch (command) {
    case 'host':
      result = await client.getHostInfo();
      break;
    case 'create':
      result = await client.createBot({
        requestId: values['request-id'],
        role: values.role,
        cwd: values.cwd,
        modelRef: values['model-ref'] ?? null,
      });
      break;
    case 'list':
      result = await client.listBots();
      break;
    case 'get':
      result = await client.getBot(values['bot-id']);
      break;
    case 'find-request':
      result = await client.findByRequest(values['request-id']);
      break;
    case 'send':
      result = await client.submit(values['bot-id'], { requestId: values['request-id'], text: values.text });
      break;
    case 'status':
      result = await client.getSubmission(values['bot-id'], values['request-id']);
      break;
    case 'history':
      result = await client.history(values['bot-id'], historyOptions);
      break;
    case 'abort':
      result = await client.abort(values['bot-id']);
      break;
    case 'context':
      result = await client.contextStatus(values['bot-id']);
      break;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (command === 'send' && result?.status === 'unanswered') {
    process.exitCode = 2;
  }
}

// 仅被直接运行（node host-core/control-cli.js）时解析 CLI；被 import 时不解析、不读 env、不发请求、不改 exitCode。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : err instanceof TypeError ? 'INVALID_ARGUMENT' : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
