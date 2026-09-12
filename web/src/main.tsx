import { createRoot } from 'react-dom/client';
import App from './App';
import { Device } from './native';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
// Resolve the Android entry before mounting the router; its fallback must not win this race.
Device.state().then(device => {
  if (!location.hash || location.hash === '#/') {
    history.replaceState(null, '', `${location.pathname}#${device.launchRoute || '/chat'}`);
  }
  root.render(<App initialDevice={device}/>);
}).catch(error => {
  root.render(<main className="page"><p role="alert">{String(error)}</p><button className="button" onClick={() => location.reload()}>重新加载 / Reload</button></main>);
});
