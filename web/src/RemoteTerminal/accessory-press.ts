// A scroll gesture must never dispatch its starting key. Hold-to-repeat begins
// only after a stationary delay; ordinary taps dispatch once on release.
export function createAccessoryPress(press: () => void, hold?: () => void, release: () => void = () => {}) {
  let point: { id:number; x:number; y:number; moved:boolean; held:boolean } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { clearTimeout(timer); timer=undefined; point=undefined; release(); };
  const start = (id:number,x:number,y:number) => {
    cancel(); point={id,x,y,moved:false,held:false};
    if (hold) timer=setTimeout(() => {if(point && !point.moved) {point.held=true; hold();}},450);
  };
  const move = (id:number,x:number,y:number) => {
    if (!point || point.id!==id) return;
    if (Math.hypot(x-point.x,y-point.y)>8) {point.moved=true; clearTimeout(timer); release();}
  };
  const end = (id:number,x:number,y:number) => {
    move(id,x,y);
    const activate=point?.id===id && !point.moved && !point.held;
    cancel(); if(activate) press();
  };
  return {start,move,end,cancel};
}
