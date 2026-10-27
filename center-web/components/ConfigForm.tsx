import { useEffect, useMemo, useState } from 'react';
import Form from '@rjsf/core';
import { customizeValidator } from '@rjsf/validator-ajv8';
import type { RJSFSchema, UiSchema, WidgetProps } from '@rjsf/utils';
import type { JsonObject, JsonSchema, JsonValue } from '@e-launcher/center-contract';
import { api } from '../api';
import './Config.css';

const validator = customizeValidator({ customFormats: { 'credential-ref': /.*/ } });
type Path = string[];
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const at = (value: JsonValue | undefined, path: Path): JsonValue | undefined => path.reduce<JsonValue | undefined>((v, key) => isObject(v) ? v[key] : undefined, value);
function setAt(value: JsonObject, path: Path, next: JsonValue | undefined): JsonObject {
  const result = { ...value }, key = path[0];
  if (path.length === 1) { if (next === undefined) delete result[key]; else result[key] = next; }
  else {
    const child = setAt(isObject(result[key]) ? result[key] as JsonObject : {}, path.slice(1), next);
    if (Object.keys(child).length) result[key] = child; else delete result[key];
  }
  return result;
}
function merge(base: JsonValue | undefined, override: JsonValue | undefined): JsonValue | undefined {
  if (override === undefined) return base;
  if (!isObject(base) || !isObject(override)) return override;
  const result = { ...base };
  for (const key of Object.keys(override)) result[key] = merge(base[key], override[key]) as JsonValue;
  return result;
}
function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (isObject(schema) && typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const path = schema.$ref.slice(2).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    const target = at(root, path);
    if (typeof target === 'boolean' || isObject(target)) return target;
  }
  return schema;
}
function fields(schema: JsonSchema, root: JsonSchema, path: Path = []): Path[] {
  const node = resolve(schema, root);
  if (isObject(node) && node.type !== 'array' && isObject(node.properties) && Object.keys(node.properties).length) {
    return Object.entries(node.properties).flatMap(([key, child]) => fields(child as JsonSchema, root, [...path, key]));
  }
  return path.length ? [path] : [];
}
function withoutDefaults(schema: JsonSchema): JsonSchema {
  if (!isObject(schema)) return schema;
  const result = { ...schema };
  delete result.default;
  for (const key of ['properties', 'patternProperties', 'definitions', '$defs']) {
    if (isObject(schema[key])) result[key] = Object.fromEntries(Object.entries(schema[key] as JsonObject).map(([name, child]) => [name, withoutDefaults(child as JsonSchema)]));
  }
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else']) {
    const child = schema[key];
    if (Array.isArray(child)) result[key] = child.map(item => withoutDefaults(item as JsonSchema));
    else if (typeof child === 'boolean' || isObject(child)) result[key] = withoutDefaults(child);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const children = schema[key];
    if (Array.isArray(children)) result[key] = children.map(child => withoutDefaults(child as JsonSchema));
  }
  return result;
}
function CredentialWidget(props: WidgetProps) {
  const [status, setStatus] = useState(''), [secret, setSecret] = useState(''), [revision, setRevision] = useState<number | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setSecret(''); setRevision(null);
    if (!props.value) { setStatus('未选择凭证'); return; }
    setStatus('正在读取凭证状态…');
    api.getCredential(String(props.value)).then(info => { if (current) { setRevision(info.revision); setStatus(info.configured ? '已配置' : '未配置'); } }).catch(() => { if (current) setStatus('无法读取凭证状态；新建可尝试保存'); });
    return () => { current = false; };
  }, [props.value]);
  return <><input id={props.id} type="text" value={props.value ?? ''} disabled={props.disabled || busy} readOnly={props.readonly} required={props.required} onChange={event => props.onChange(event.target.value || undefined)} aria-describedby={`${props.id}-status`}/><small id={`${props.id}-status`}>凭证 ID · {status}（不显示密钥）</small>{props.value && !props.disabled && !props.readonly && <div><label>写入新密钥 <input type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)}/></label><button type="button" disabled={!secret || busy} onClick={() => { setBusy(true); api.putCredential(String(props.value), { value: secret, expectedRevision: revision }).then(info => { setRevision(info.revision); setSecret(''); setStatus(info.configured ? '已配置' : '未配置'); }).catch(error => setStatus(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false)); }}>保存凭证</button></div>}</>;
}
function makeUi(schema: JsonSchema, root: JsonSchema, ui: JsonObject, path: Path, selected: JsonObject | undefined): JsonObject {
  const node = resolve(schema, root), result: JsonObject = { ...ui };
  if (isObject(node) && node.type !== 'array' && isObject(node.properties) && Object.keys(node.properties).length) {
    for (const [key, child] of Object.entries(node.properties)) result[key] = makeUi(child as JsonSchema, root, isObject(ui[key]) ? ui[key] as JsonObject : {}, [...path, key], selected);
  } else {
    if (selected && at(selected, path) === undefined) result['ui:disabled'] = true;
    if (isObject(node) && node.format === 'credential-ref') result['ui:widget'] = 'credentialRef';
  }
  return result;
}

export default function ConfigForm({ schema, uiSchema, globalConfig, overrides, onSave }: { schema: JsonSchema; uiSchema?: JsonObject; globalConfig: JsonObject; overrides?: JsonObject; onSave(value: JsonObject): void }) {
  const [value, setValue] = useState<JsonObject>(overrides ?? globalConfig);
  useEffect(() => setValue(overrides ?? globalConfig), [globalConfig, overrides]);
  const paths = useMemo(() => fields(schema, schema), [schema]);
  const effective = overrides === undefined ? value : merge(globalConfig, value) as JsonObject;
  const ui = makeUi(schema, schema, uiSchema ?? {}, [], overrides === undefined ? undefined : value);
  return <div className="config-form">
    {overrides !== undefined && <fieldset><legend>Bot 覆盖字段</legend><p>未勾选的字段继承全局配置；数组作为整体替换。</p>{paths.map(path => {
      const active = at(value, path) !== undefined;
      return <label className="config-override" key={JSON.stringify(path)}><input type="checkbox" checked={active} onChange={event => setValue(current => setAt(current, path, event.target.checked ? at(effective, path) ?? null : undefined))}/>{path.join(' › ')} {active ? '覆盖' : '继承'}</label>;
    })}</fieldset>}
    <Form schema={withoutDefaults(schema) as RJSFSchema} uiSchema={ui as UiSchema} validator={validator} widgets={{ credentialRef: CredentialWidget }} formData={effective} onChange={({ formData }) => {
      if (!isObject(formData)) return;
      if (overrides === undefined) setValue(formData);
      else setValue(current => paths.reduce((next, path) => at(current, path) === undefined ? next : setAt(next, path, at(formData, path) ?? null), current));
    }} onSubmit={() => onSave(value)}><button type="submit">保存配置</button></Form>
  </div>;
}
