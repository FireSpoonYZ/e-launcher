import { useState } from 'react';
import { api } from '../api';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <main className="page login"><h1>登录中心</h1><form className="form" onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void api.login({ password }).then(() => { setPassword(''); window.location.assign('/providers'); }).catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false)); }}><label>所有者口令<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>{error && <p className="inline-error" role="alert">{error}</p>}<button className="button" disabled={busy}>登录</button></form></main>;
}
