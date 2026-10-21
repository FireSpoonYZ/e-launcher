import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createControlClient } from './control-client.js';
import { invalid, readInputObject } from './cli-input.js';

const USAGE = `usage: node host-core/control-cli.js <host|create|list|get|find-request|send|status|history|abort|context|live|work-get|work-sync|work-history|work-context|work-activity|work-stop|work-resume|scope-list|scope-get|scope-create|scope-update|scope-send|scope-replicas> [options]

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
  live             stream live bot frames, one JSON line per frame; requires --bot-id
  work-get         print one work context; requires --bot-id --scope-id
  work-sync        import one inbox page without inference; requires --bot-id --scope-id [--limit]
  work-history     list work context history; requires --bot-id --scope-id [--limit] [--cursor]
  work-context     print work context status; requires --bot-id --scope-id
  work-activity    print work activity; requires --bot-id --scope-id
  work-stop        persistently stop work in one scope; requires --bot-id --scope-id
  work-resume      resume stopped or failed work in one scope; requires --bot-id --scope-id
  scope-list       list managed scopes; [--limit] [--cursor]
  scope-get        print one scope; requires --scope-id
  scope-create     create a managed scope; requires --input
  scope-update     update scope members; requires --scope-id --input
  scope-send       publish a user message; requires --scope-id --input
  scope-replicas   list replica observations; requires --scope-id [--limit] [--cursor]

options:
  --url <url>         host control server URL (required, except --help)
  --token-env <name>  environment variable holding the bearer token (required, except --help)
  --bot-id <id>
  --scope-id <id>     scope (work-*/scope-* commands only)
  --request-id <id>
  --role <text>
  --cwd <dir>
  --model-ref <value>
  --text <text>
  --input <file>       input JSON file: max 1MiB, UTF-8, a single plain object (never stdin)
  --limit <int>       strict decimal positive integer (history, work-sync, work-history, scope-list, scope-replicas)
  --cursor <json>     JSON object cursor (history, work-history, scope-list, scope-replicas)
  -h, --help          show this help
`;

const OPTIONS = {
  url: { type: 'string' },
  'token-env': { type: 'string' },
  'bot-id': { type: 'string' },
  'scope-id': { type: 'string' },
  'request-id': { type: 'string' },
  role: { type: 'string' },
  cwd: { type: 'string' },
  'model-ref': { type: 'string' },
  text: { type: 'string' },
  input: { type: 'string' },
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
  live: ['bot-id'],
  'work-get': ['bot-id', 'scope-id'],
  'work-sync': ['bot-id', 'scope-id'],
  'work-history': ['bot-id', 'scope-id'],
  'work-context': ['bot-id', 'scope-id'],
  'work-activity': ['bot-id', 'scope-id'],
  'work-stop': ['bot-id', 'scope-id'],
  'work-resume': ['bot-id', 'scope-id'],
  'scope-list': [],
  'scope-get': ['scope-id'],
  'scope-create': ['input'],
  'scope-update': ['scope-id', 'input'],
  'scope-send': ['scope-id', 'input'],
  'scope-replicas': ['scope-id'],
};

// host/list 不接受资源参数；work-* 只接受各自的必需项及分页项。
const RESOURCE_OPTIONS = ['bot-id', 'scope-id', 'request-id', 'role', 'cwd', 'model-ref', 'text', 'input', 'limit', 'cursor'];

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  const workCommand = command.startsWith('work-');
  const scopeCommand = command.startsWith('scope-');
  if (command === 'host' || command === 'list' || workCommand || scopeCommand) {
    const allowed = [...REQUIRED[command]];
    if (command === 'work-sync' || command === 'work-history') allowed.push('limit');
    if (command === 'work-history') allowed.push('cursor');
    if (command === 'scope-list' || command === 'scope-replicas') allowed.push('limit', 'cursor');
    for (const key of RESOURCE_OPTIONS) {
      if (values[key] !== undefined && !allowed.includes(key)) {
        throw invalid(`${command} does not take --${key}`);
      }
    }
  } else {
    if (values['scope-id'] !== undefined) {
      throw invalid(`${command} does not take --scope-id`);
    }
    if (values.input !== undefined) {
      throw invalid(`${command} does not take --input`);
    }
  }
  const pageOptions = {};
  if (command === 'history' || command === 'work-history' || command === 'work-sync' || command === 'scope-list' || command === 'scope-replicas') {
    if (values.limit !== undefined) pageOptions.limit = parseLimit(values.limit);
    if (values.cursor !== undefined) pageOptions.cursor = parseCursor(values.cursor);
  }

  const input = values.input !== undefined ? readInputObject(values.input) : undefined;

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
      result = await client.history(values['bot-id'], pageOptions);
      break;
    case 'abort':
      result = await client.abort(values['bot-id']);
      break;
    case 'context':
      result = await client.contextStatus(values['bot-id']);
      break;
    case 'work-get':
      result = await client.getWorkContext(values['bot-id'], values['scope-id']);
      break;
    case 'work-sync':
      result = await client.syncWorkContext(values['bot-id'], values['scope-id'], pageOptions);
      break;
    case 'work-history':
      result = await client.workHistory(values['bot-id'], values['scope-id'], pageOptions);
      break;
    case 'work-context':
      result = await client.workContextStatus(values['bot-id'], values['scope-id']);
      break;
    case 'work-activity':
      result = await client.getWorkActivity(values['bot-id'], values['scope-id']);
      break;
    case 'work-stop':
      result = await client.stopWork(values['bot-id'], values['scope-id']);
      break;
    case 'work-resume':
      result = await client.resumeWork(values['bot-id'], values['scope-id']);
      break;
    case 'scope-list':
      result = await client.listScopeStates(pageOptions);
      break;
    case 'scope-get':
      result = await client.getScopeState(values['scope-id']);
      break;
    case 'scope-create':
      result = await client.createScope(input);
      break;
    case 'scope-update':
      result = await client.updateScope(values['scope-id'], input);
      break;
    case 'scope-send':
      result = await client.publishUserMessage(values['scope-id'], input);
      break;
    case 'scope-replicas':
      result = await client.listScopeReplicas(values['scope-id'], pageOptions);
      break;
    case 'live':
      await streamLive(client, values['bot-id']);
      return;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (command === 'send' && result?.status === 'unanswered') {
    process.exitCode = 2;
  }
}

// live 是唯一流式命令：逐帧一行 JSON。SIGINT/SIGTERM/EPIPE 只取消本流并正常退出。
async function streamLive(client, botId) {
  const ac = new AbortController();
  let writeError = null;
  const stop = () => ac.abort();
  const onStdoutError = (err) => {
    if (err?.code !== 'EPIPE') writeError = err;
    stop();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdout.on('error', onStdoutError);
  try {
    for await (const frame of client.live(botId, { signal: ac.signal })) {
      if (!process.stdout.write(JSON.stringify(frame) + '\n')) {
        // 背压：等待 drain；AbortSignal 保证信号/EPIPE 可打断，不会无限挂起。
        await once(process.stdout, 'drain', { signal: ac.signal });
      }
    }
  } catch (err) {
    if (writeError) throw writeError;
    if (!ac.signal.aborted) throw err;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.stdout.removeListener('error', onStdoutError);
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
