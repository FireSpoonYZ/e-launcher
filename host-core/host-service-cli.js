// 统一本机服务与离线设置 CLI：默认 serve；显式 serve/settings-get/settings-set。
// 仅被直接运行时解析参数；被 import 时不读 env/文件、不监听 stdin/信号、不改 exitCode。
import { parseArgs } from 'node:util';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { openHost } from './host.js';
import { openHostSettings } from './host-settings.js';
import { openHostService } from './host-service.js';
import { invalid, readInputObject } from './cli-input.js';

const USAGE = `usage: node host-core/host-service-cli.js [serve|settings-get|settings-set] [options]

commands (default: serve):
  serve          start the unified local host service; requires --data-root --token-env [--port] [--initial-settings]
  settings-get   print the persisted local host settings snapshot; requires --data-root
  settings-set   replace persisted local host settings (next startup only); requires --data-root --input

options:
  --data-root <dir>         verified absolute data directory (required)
  --token-env <name>        environment variable holding the control token (serve only, required)
  --port <int>              TCP port on 127.0.0.1, decimal 0..65535 (serve only, default 8787)
  --initial-settings <file> settings seed file: single JSON object {runtime,relay} (serve only)
  --input <file>            settings-set input file: single JSON object {expectedRevision,settings} (required)
  -h, --help                show this help
`;

const COMMANDS = new Set(['serve', 'settings-get', 'settings-set']);

const OPTIONS = {
  'data-root': { type: 'string' },
  'token-env': { type: 'string' },
  port: { type: 'string' },
  'initial-settings': { type: 'string' },
  input: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const ALLOWED_FLAGS = {
  serve: ['data-root', 'token-env', 'port', 'initial-settings'],
  'settings-get': ['data-root'],
  'settings-set': ['data-root', 'input'],
};

const REQUIRED = {
  serve: ['data-root', 'token-env'],
  'settings-get': ['data-root'],
  'settings-set': ['data-root', 'input'],
};

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parsePort(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw invalid('--port must be a strict decimal integer');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw invalid('--port must be in range 0..65535');
  }
  return port;
}

function parseDataRoot(value) {
  if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
    throw invalid('--data-root must be a non-empty absolute path');
  }
  return path.resolve(value);
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

function validateSettingsPatch(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('--input must be a plain object');
  }
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('expectedRevision') || !keys.includes('settings')) {
    throw invalid('--input must contain exactly expectedRevision and settings');
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) {
    throw invalid('expectedRevision must be a positive safe integer');
  }
  if (typeof input.settings !== 'object' || input.settings === null || Array.isArray(input.settings)) {
    throw invalid('settings must be a plain object');
  }
}

function parseArgv() {
  const argv = process.argv.slice(2);
  const hasCommand = argv.length > 0 && !argv[0].startsWith('-');
  const command = hasCommand ? argv[0] : 'serve';
  let values;
  let tokens;
  try {
    ({ values, tokens } = parseArgs({
      args: hasCommand ? argv.slice(1) : argv,
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
      tokens: true,
    }));
  } catch (err) {
    throw invalid(err.message);
  }
  // 拒绝重复选项：parseArgs 默认 last-wins，tokens 逐项核对避免静默覆盖。
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind === 'option') {
      if (seen.has(token.name)) {
        throw invalid(`duplicate option --${token.name}`);
      }
      seen.add(token.name);
    }
  }
  if (!COMMANDS.has(command)) {
    throw invalid(`unknown command: ${command}`);
  }
  return { command, values };
}

function probeDeviceId(dataRoot) {
  const probe = openHost({ dataRoot });
  try {
    return probe.deviceId;
  } finally {
    probe.close();
  }
}

async function settingsGet(dataRoot) {
  const store = openHostSettings({ dataRoot, deviceId: probeDeviceId(dataRoot) });
  try {
    return store.get();
  } finally {
    store.close();
  }
}

async function settingsSet(dataRoot, patch) {
  const store = openHostSettings({ dataRoot, deviceId: probeDeviceId(dataRoot) });
  try {
    return store.replace({ expectedRevision: patch.expectedRevision, settings: patch.settings });
  } finally {
    store.close();
  }
}

async function serve(values) {
  const options = { dataRoot: parseDataRoot(values['data-root']) };
  options.token = tokenFromEnv(values['token-env']);
  if (values.port !== undefined) options.port = parsePort(values.port);
  if (values['initial-settings'] !== undefined) {
    options.initialSettings = readInputObject(values['initial-settings']);
  }

  const service = await openHostService(options);

  // 私有管理通道：stdin 一行 shutdown / SIGINT / SIGTERM 触发同一幂等 await close；
  // stdin EOF 不关服务，不 abort Agent。
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    rl.close();
    service.close().then(
      () => process.exit(0),
      (err) => {
        const code = typeof err?.code === 'string' ? err.code : 'INTERNAL';
        process.stderr.write(
          JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n',
          () => process.exit(1)
        );
      }
    );
  };
  rl.on('line', (line) => {
    if (line.trim() === 'shutdown') shutdown();
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.stdout.write(JSON.stringify({ event: 'listening', deviceId: service.deviceId, url: service.url }) + '\n');
}

async function main() {
  const { command, values } = parseArgv();

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  for (const key of Object.keys(OPTIONS)) {
    if (key === 'help') continue;
    if (values[key] !== undefined && !ALLOWED_FLAGS[command].includes(key)) {
      throw invalid(`${command} does not take --${key}`);
    }
  }
  for (const key of REQUIRED[command]) {
    if (values[key] === undefined) {
      throw invalid(`missing required option --${key}`);
    }
  }

  if (command === 'serve') {
    await serve(values);
    return;
  }

  const dataRoot = parseDataRoot(values['data-root']);
  let result;
  if (command === 'settings-get') {
    result = await settingsGet(dataRoot);
  } else {
    const patch = readInputObject(values.input);
    validateSettingsPatch(patch);
    result = await settingsSet(dataRoot, patch);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

// 仅被直接运行（node host-core/host-service-cli.js）时执行；被 import 时不解析、
// 不读 env/文件、不监听 stdin/信号、不写 exitCode。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    const code = typeof err?.code === 'string' ? err.code : err instanceof TypeError ? 'INVALID_ARGUMENT' : 'INTERNAL';
    process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err) } }) + '\n');
    process.exitCode = 1;
  });
}
