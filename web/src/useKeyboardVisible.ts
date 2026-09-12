import { useEffect, useState } from 'react';
import { Device } from './native';

export function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let live = true, received = false;
    const listener = Device.addListener('keyboardEvent', state => { received = true; if (live) setVisible(state.visible); });
    void listener.then(() => Device.keyboardState()).then(state => { if (live && !received) setVisible(state.visible); }).catch(console.error);
    return () => { live = false; void listener.then(handle => handle.remove()); };
  }, []);
  return visible;
}
