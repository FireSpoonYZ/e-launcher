import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { defineTool } from '@earendil-works/pi-durable';
import { resolveBotIdentity } from './bot-identity.js';
import { digest, messageError } from './message-protocol.js';
import { inboxQueryKey } from './message-queries.js';

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_TEXT_UNITS = 4096;
const WAIT_MS = 30_000;
const TOOL_ERROR_CODES = new Set([
  'INVALID_ARGUMENT', 'BOT_NOT_FOUND', 'BOT_CONTEXT_REQUIRED',
  'SCOPE_NOT_FOUND', 'SCOPE_FORBIDDEN', 'MESSAGE_NOT_FOUND', 'REQUEST_CONFLICT',
  'STALE_INPUT', 'WORK_STOPPED', 'WORK_CONTEXT_INACTIVE', 'RESPONSE_TOO_LARGE',
]);
const ID_SCHEMA = { type: 'string', minLength: 1 };
const LIMIT_SCHEMA = { type: 'integer', minimum: 1, maximum: 200 };
const CURSOR_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      properties: {
        deviceId: ID_SCHEMA,
        kind: { type: 'string', enum: ['inbox'] },
        key: ID_SCHEMA,
        afterLocalId: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
      required: ['deviceId', 'kind', 'key', 'afterLocalId'],
      additionalProperties: false,
    },
    { type: 'null' },
  ],
};

function output(result) {
  return { output: [{ type: 'text', text: JSON.stringify(result) }] };
}

function fits(result) {
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_OUTPUT_BYTES;
}

function preview(item) {
  const { message } = item;
  let end = Math.min(message.text.length, MAX_TEXT_UNITS);
  // Ledger text is well formed; never split a surrogate pair at the preview boundary.
  const last = message.text.charCodeAt(end - 1);
  if (end < message.text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return {
    localId: item.localId,
    messageId: message.messageId,
    sourceDeviceId: message.sourceDeviceId,
    scopeId: message.scopeId,
    author: message.author,
    category: message.category,
    rootId: message.rootId,
    replyTo: message.replyTo,
    text: message.text.slice(0, end),
    createdAt: message.createdAt,
    selfEcho: item.selfEcho,
    textTruncated: end < message.text.length,
  };
}

function previewPage(metadata, page, key) {
  const result = { ...metadata, items: [], nextCursor: page.nextCursor };
  for (let index = 0; index < page.items.length; index += 1) {
    const item = preview(page.items[index]);
    const previousCursor = result.nextCursor;
    result.items.push(item);
    result.nextCursor = index + 1 < page.items.length
      ? { deviceId: metadata.deviceId, kind: 'inbox', key, afterLocalId: item.localId }
      : page.nextCursor;
    if (!fits(result)) {
      result.items.pop();
      result.nextCursor = previousCursor;
      // One preview fits under the protocol's ID limits; fail rather than skip input if violated.
      if (result.items.length === 0) throw new Error('message preview exceeds the tool response size limit');
      break;
    }
  }
  return result;
}

function replyPage(identity, page, status) {
  const metadata = {
    deviceId: identity.deviceId,
    botId: identity.botId,
    requestMessageId: page.requestMessageId,
    scopeId: page.scopeId,
  };
  if (status !== undefined) metadata.status = status;
  return previewPage(metadata, page, 'reply:' + digest([identity.botId, page.requestMessageId]));
}

export function createCommunicationTools({ host, getHarness, getMessageLog, publishWork }) {
  function tool({ name, description, properties, required = [], run }) {
    return defineTool({
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      replay: 'safe',
      outputLimits: { maxBytes: MAX_OUTPUT_BYTES },
      async execute(args, api, context) {
        try {
          context.abortSignal?.throwIfAborted();
          const identity = await resolveBotIdentity(host, getHarness(), api.conversationId, context);
          context.abortSignal?.throwIfAborted();
          return output(await run(args, identity, getMessageLog(), api, context));
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          if (!TOOL_ERROR_CODES.has(error?.code)) throw error;
          return { ...output({ code: error.code, message: error.message }), isError: true };
        }
      },
    });
  }

  async function send(kind, args, identity, log, api, context) {
    const scope = log.getScope(args.scopeId);
    if (!scope) throw messageError('SCOPE_NOT_FOUND', 'scope not installed');
    if (scope.kind !== kind) throw messageError('SCOPE_FORBIDDEN', `target scope must be ${kind}`);
    let messageId = await api.memo('host.message-id', context);
    if (messageId === undefined) {
      messageId = await api.memo('host.message-id', randomUUID(), context);
    }
    const publication = {
      messageId,
      scopeId: args.scopeId,
      author: { kind: 'bot', botId: identity.botId },
      category: kind === 'room' ? 'public' : args.category,
      text: args.text,
      replyTo: args.replyTo,
    };
    const stored = identity.scopeId !== null
      ? await publishWork(publication, api, context)
      : await api.commit(() => {
          context.abortSignal?.throwIfAborted();
          return log.publish(publication);
        }, context);
    const message = stored.message;
    return {
      messageId: message.messageId,
      scopeId: message.scopeId,
      author: message.author,
      category: message.category,
      rootId: message.rootId,
      replyTo: message.replyTo,
      createdAt: message.createdAt,
      status: 'stored',
    };
  }

  return [
    tool({
      name: 'list_scopes',
      description: 'List installed scopes containing this Bot as a current member. Offsets are best effort when membership changes.',
      properties: { offset: { type: 'integer', minimum: 0 }, limit: LIMIT_SCHEMA },
      run(args, identity, log) {
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 50;
        const scopes = log.listScopes().filter((scope) => scope.members.some(
          (member) => member.deviceId === identity.deviceId && member.botId === identity.botId,
        ));
        const result = { deviceId: identity.deviceId, botId: identity.botId, scopes: [], nextOffset: null };
        for (let index = offset; index < Math.min(scopes.length, offset + limit); index += 1) {
          result.scopes.push(scopes[index]);
          result.nextOffset = index + 1 < scopes.length ? index + 1 : null;
          if (!fits(result)) {
            result.scopes.pop();
            if (result.scopes.length === 0) {
              throw messageError('RESPONSE_TOO_LARGE', 'a scope exceeds the tool response size limit');
            }
            result.nextOffset = index;
            break;
          }
        }
        return result;
      },
    }),
    tool({
      name: 'read_scope',
      description: 'Read messages frozen for this Bot in an installed scope, including after exit. Returns bounded text previews and an exact continuation cursor; raw ledger text is unchanged.',
      properties: { scopeId: ID_SCHEMA, limit: LIMIT_SCHEMA, cursor: CURSOR_SCHEMA },
      required: ['scopeId'],
      run(args, identity, log) {
        const page = log.inbox(identity.botId, { scopeId: args.scopeId, limit: args.limit, cursor: args.cursor });
        return previewPage(
          { deviceId: identity.deviceId, botId: identity.botId, scopeId: args.scopeId },
          page,
          inboxQueryKey(identity.botId, args.scopeId),
        );
      },
    }),
    tool({
      name: 'send_room',
      description: 'Publish a public message to an installed room as this Bot. Optional replyTo references a stored message in that room. The receipt means stored locally, not delivered remotely.',
      properties: { scopeId: ID_SCHEMA, text: { type: 'string', minLength: 1 }, replyTo: ID_SCHEMA },
      required: ['scopeId', 'text'],
      run: (args, identity, log, api, context) => send('room', args, identity, log, api, context),
    }),
    tool({
      name: 'send_dm',
      description: 'Send to an installed DM scope as this Bot: notice is informational, request asks for work, reply answers an original request and requires its messageId as replyTo. Do not turn a reply into a new request. Returns only a local stored receipt; no scopes are created.',
      properties: {
        scopeId: ID_SCHEMA,
        category: { type: 'string', enum: ['notice', 'request', 'reply'] },
        text: { type: 'string', minLength: 1 },
        replyTo: ID_SCHEMA,
      },
      required: ['scopeId', 'category', 'text'],
      run: (args, identity, log, api, context) => send('dm', args, identity, log, api, context),
    }),
    tool({
      name: 'read_dm_replies',
      description: 'Read counterpart replies directly linked to this Bot\'s original DM requestMessageId. Returns previews and a continuation cursor; does not send another request or start inference.',
      properties: { requestMessageId: ID_SCHEMA, limit: LIMIT_SCHEMA, cursor: CURSOR_SCHEMA },
      required: ['requestMessageId'],
      run(args, identity, log) {
        return replyPage(identity, log.replies(identity.botId, args.requestMessageId, {
          limit: args.limit, cursor: args.cursor,
        }));
      },
    }),
    tool({
      name: 'wait_dm_reply',
      description: 'Wait up to 30 seconds for the first counterpart reply to this Bot\'s DM requestMessageId. A restart does not extend this invocation\'s deadline. Timeout never cancels the recipient; later read or wait calls use the same requestMessageId.',
      properties: { requestMessageId: ID_SCHEMA },
      required: ['requestMessageId'],
      async run(args, identity, log, api, context) {
        let deadline = await api.memo('host.wait-deadline', context);
        if (deadline === undefined) {
          deadline = await api.memo('host.wait-deadline', Date.now() + WAIT_MS, context);
        }
        for (;;) {
          context.abortSignal?.throwIfAborted();
          const page = log.replies(identity.botId, args.requestMessageId, { limit: 1 });
          // Check stored replies before the deadline, including replies received during downtime.
          if (page.items.length > 0) return replyPage(identity, page, 'replied');
          const remaining = deadline - Date.now();
          if (remaining <= 0) return replyPage(identity, page, 'timeout');
          await delay(Math.min(1000, remaining), undefined, { signal: context.abortSignal });
        }
      },
    }),
  ];
}
