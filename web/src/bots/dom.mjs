export function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls)
        n.className = cls;
    if (text !== undefined)
        n.textContent = String(text);
    return n;
}
export function button(label, action, cls = 'eb-icon-button') {
    const n = el('button', cls);
    n.type = 'button';
    n.setAttribute('aria-label', label);
    n.title = label;
    if (action)
        n.addEventListener('click', action);
    return n;
}
export function svgNode(tag, attrs) { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs))
    n.setAttribute(k, String(v)); return n; }
const icons = {
    back: 'm14 5-7 7 7 7', close: 'm6 6 12 12M18 6 6 18', menu: 'M4 6h16M4 12h16M4 18h16', plus: 'M12 5v14M5 12h14',
    arrow: 'M5 12h14m-5-5 5 5-5 5', send: 'M12 19V5m-6 6 6-6 6 6', chevron: 'm9 5 7 7-7 7',
    clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    chat: 'M20 11c0 5-4 8-8 8H4l1-4a8 8 0 1 1 15-4Z',
    link: 'm9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
    check: 'm5 12 4 4L19 6', pause: 'M8 5v14M16 5v14', play: 'm8 5 11 7-11 7Z', more: 'M5 12h.01M12 12h.01M19 12h.01',
    sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    search: 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    info: 'M12 10v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    settings: 'M12 8v8M8 12h8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'
};
export function icon(name) { const s = svgNode('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }); s.append(svgNode('path', { d: icons[name] ?? icons.info })); return s; }
export function textButton(label, action, cls = 'eb-button') { const n = button(label, action, cls); n.textContent = label; return n; }
export function labelledInput(label, { value = '', type = 'text', placeholder = '', multiline = false } = {}) {
    const wrap = el('label', 'eb-field'), title = el('span', '', label), input = el(multiline ? 'textarea' : 'input');
    if (!multiline)
        input.type = type;
    input.value = value;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', label);
    wrap.append(title, input);
    return { wrap, input };
}
