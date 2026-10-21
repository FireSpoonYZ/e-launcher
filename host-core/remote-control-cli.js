// host-core/remote-control-cli.js
//
// Module 9 一次性远程控制 CLI：通过已认证中继向目标设备 Host 发送固定 JSON 控制方法，
// 成功在 stdout 输出单个原始 JSON 结果。本 CLI 不持有 Host 锁、不创建任何本地数据
// 文件；同设备 Host/Agent 可并行运行。
import { parseArgs } from 'node:util';
import { statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertId } from './message-protocol.js';
import { CONTROL_METHODS, normalizeControlCall } from './remote-control-protocol.js';
import { openRemoteControl, RemoteControlError } from './remote-control-client.js';

const MAX_INPUT_BYTES = 1024 * 1024;

const USAGE = `usage: node host-core/remote-control-cli.js <METHOD> --device-id <id> --target-device-id <id> --url <ws(s)://.../v1/link> --token-env <name> [--input <file>] [--ca <file>]

methods (params come from --input):
  getHostInfo       print target host info; params {}
  listBots          list bot records; params {}
  createBot         create a bot; params {requestId,role,cwd,modelRef?}
  getBot            get one bot; params {botId}
  findByRequest      find bot by request; params {requestId}
  submit            submit a message; params {botId,requestId,text}
  getSubmission     get one submission; params {botId,requestId}
  history           conversation history; params {botId,limit?,cursor?}
  abort             abort a bot's current work; params {botId}
  contextStatus     print context status; params {botId}

options:
  --device-id <id>         local source device id (required)
  --target-device-id <id>  target device id hosting the control API (required)
  --url <url>              relay WebSocket URL (required; path must be /v1/link)
  --token-env <name>       environment variable holding the device token (required, must be set)
  --input <file>           params JSON file: max 1MiB, UTF-8, a single plain object (optional; default {})
  --ca <file>              custom CA bundle PEM file, regular UTF-8, max 1MiB (optional)
  -h, --help               show this help
`;

const OPTIONS = {
  'device-id': { type: 'string' },
  'target-device-id': { type: 'string' },
  url: { type: 'string' },
  'token-env': { type: 'string' },
  input: { type: 'string' },
  ca: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const REQUIRED = ['device-id', 'target-device-id', 'url', 'token-env'];

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

function tokenFromEnv(name) {
  if (!ENV_NAME_RE.test(name)) {
    throw invalid('--token-env must be a valid environment variable name');
  }
  const token = process.env[name];
  if (token === undefined || token === '') {
    throw invalid(`environment variable ${name} is not set`);
  }
  return token;
}

// 先 statSync 拒绝非普通文件（含 device/FIFO，避免阻塞打开），open 后 fstat 取真实大小，
// 大小超限直接拒绝，缓冲/读取最多 1MiB+1，绝不无界 readFile。
function readFileText(file, label) {
  let fd;
  try {
    const st = statSync(file);
    if (!st.isFile()) {
      throw invalid(`${label} must be a regular file`);
    }
    fd = openSync(file, 'r');
    const real = fstatSync(fd);
    if (!real.isFile()) {
      throw invalid(`${label} must be a regular file`);
    }
    if (real.size > MAX_INPUT_BYTES) {
      throw invalid(`${label} exceeds 1MiB`);
    }
    const buf = Buffer.allocUnsafe(real.size + 1);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead !== real.size) {
      throw invalid(`${label} changed while reading`);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, bytesRead));
    } catch {
      throw invalid(`${label} is not valid UTF-8`);
    }
  } catch (err) {
    if (err?.code === 'INVALID_ARGUMENT') throw err;
    throw invalid(`cannot read ${label}: ${err.message}`);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 关闭失败不掩盖原错误。
      }
    }
  }
}

function readInputObject(file) {
  const text = readFileText(file, '--input file');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid('--input file must contain a single JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('--input file must contain a single JSON object');
  }
  return parsed;
}

function readCaFile(file) {
  const text = readFileText(file, '--ca');
  if (text.trim() === '') {
    throw invalid('--ca file is empty');
  }
  return text;
}

function parseArgv() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ options: OPTIONS, strict: true, allowPositionals: true }));
  } catch (err) {
    throw invalid(err.message);
  }
  return { values, positionals };
}

async function main() {
  const { values, positionals } = parseArgv();
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    throw invalid('exactly one method name is required');
  }
  const method = positionals[0];
  if (!CONTROL_METHODS.includes(method)) {
    throw invalid(`unknown method: ${method}`);
  }
  for (const key of REQUIRED) {
    if (values[key] === undefined) {
      throw invalid(`missing required option --${key}`);
    }
  }
  assertId(values['device-id'], 'deviceId');
  assertId(values['target-device-id'], 'targetDeviceId');
  // token 仅来自环境变量，绝不作为 flag 值、绝不输出。
  const token = tokenFromEnv(values['token-env']);
  // 文件/参数校验全部发生在 openRemoteControl 之前：坏参数不会发起任何连接。
  const ca = values.ca === undefined ? undefined : readCaFile(values.ca);
  const input = values.input === undefined ? {} : readInputObject(values.input);
  const { method: methodName, params } = normalizeControlCall(method, input);

  // SIGINT/SIGTERM 只取消启动/等待并关闭客户端，绝不发送 abort 控制方法；
  // 退出码遵循 shell 约定 130/143。
  const ac = new AbortController();
  let signalCode = null;
  const onSignal = (sig) => {
    signalCode = sig === 'SIGINT' ? 130 : 143;
    ac.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let client = null;
  let workError = null;
  try {
    client = await openRemoteControl({
      deviceId: values['device-id'],
      url: values.url,
      token,
      ...(ca !== undefined ? { ca } : {}),
      signal: ac.signal,
    });
    if (signalCode !== null) return signalCode;
    const result = await client.call(values['target-device-id'], methodName, params, { signal: ac.signal });
    if (signalCode !== null) return signalCode;
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (err) {
    if (signalCode !== null) return signalCode;
    workError = err;
    throw err;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (client !== null) {
      try {
        await client.close();
      } catch (cleanupErr) {
        if (workError === null && signalCode === null) throw cleanupErr;
      }
    }
  }
}

// 仅被直接运行（node host-core/remote-control-cli.js）时解析 CLI；被 import 时不解析、
// 不读 env/文件、不连接、不改 exitCode。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      const outcome = err instanceof RemoteControlError ? err.outcome : 'not-sent';
      const code =
        err instanceof RemoteControlError
          ? err.code
          : typeof err?.code === 'string'
            ? err.code
            : err instanceof TypeError
              ? 'INVALID_ARGUMENT'
              : 'INTERNAL';
      process.stderr.write(JSON.stringify({ error: { code, message: err?.message ?? String(err), outcome } }) + '\n');
      process.exitCode = outcome === 'unconfirmed' ? 2 : 1;
    }
  );
}
