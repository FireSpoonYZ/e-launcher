import { COLORS, persona, stateOf, STATES } from './model.mjs';
import { el, svgNode } from './dom.mjs';
// Original geometry. No upstream paths, images, fonts or animation code are included.
const paths = {
    pebble: 'M15 34C17 10 43 4 63 13C85 16 94 35 87 57C84 80 68 91 44 87C20 91 8 64 15 34Z',
    squircle: 'M29 11H71Q90 11 90 31V69Q90 89 71 89H29Q10 89 10 69V31Q10 11 29 11Z',
    drop: 'M50 9C62 9 73 31 85 50C98 77 73 92 51 91C25 91 4 75 17 49C28 30 39 9 50 9Z',
    cloud: 'M18 40C5 25 28 10 42 19C53 2 74 9 75 27C97 26 99 51 84 60C99 78 73 96 59 84C41 99 20 88 23 73C2 71 2 45 18 40Z',
    hex: 'M36 10Q50 3 64 11L84 24Q94 30 94 43V60Q94 74 81 80L63 91Q50 96 37 89L16 77Q6 70 7 56V39Q8 28 20 20Z',
    pill: 'M32 13H67C98 13 99 86 68 86H32C1 86 2 13 32 13Z',
    leaf: 'M16 18C50 1 91 19 87 53C85 81 46 97 20 81C33 68 2 48 16 18Z',
    star: 'M51 8Q62 24 74 18Q92 19 81 38Q77 49 91 58Q96 72 75 73Q62 70 58 87Q47 99 40 82Q36 69 20 75Q5 71 17 55Q29 43 17 31Q12 15 31 21Q42 25 44 11Q47 4 51 8Z'
};
export function createAvatar(bot, { size = 44, staticPose = false } = {}) {
    const p = persona(bot), state = stateOf(bot), wrap = el('span', 'eb-avatar');
    wrap.style.setProperty('--avatar-size', `${size}px`);
    wrap.dataset.botId = bot.id;
    wrap.dataset.state = state;
    wrap.dataset.static = String(staticPose);
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', `${bot.name} · ${STATES[state]}`);
    const svg = svgNode('svg', { viewBox: '0 0 100 104', width: size, height: size, 'aria-hidden': 'true' });
    const shadow = svgNode('ellipse', { cx: 50, cy: 99, rx: 23, ry: 2.5, fill: 'currentColor', opacity: .07, class: 'eb-avatar-shadow' });
    const body = svgNode('g', { class: 'eb-avatar-body' });
    body.append(svgNode('path', { d: paths[p.shape], fill: COLORS[p.color] }));
    const face = svgNode('g', { class: 'eb-avatar-face', fill: '#fffdf9' });
    const eyes = svgNode('g', { class: 'eb-avatar-eyes' });
    eyes.append(svgNode('rect', { x: 34, y: 42, width: 9, height: 15, rx: 4.5 }), svgNode('rect', { x: 57, y: 42, width: 9, height: 15, rx: 4.5 }));
    face.append(eyes);
    body.append(face);
    svg.append(shadow, body);
    wrap.append(svg);
    return wrap;
}
/** One observer per mounted workspace; no per-avatar JS animation loops. */
export function observeAvatars(root) {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let dead = false;
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(items => {
        for (const item of items)
            item.target.dataset.offscreen = String(!item.isIntersecting);
    }, { rootMargin: '10px' }) : null;
    const update = () => { root.dataset.motionPaused = String(document.hidden || reduced.matches || root.dataset.userPaused === 'true'); };
    const move = e => {
        if (root.dataset.motionPaused === 'true' || e.pointerType === 'touch')
            return;
        const avatar = e.target.closest?.('.eb-avatar');
        if (!avatar || !root.contains(avatar))
            return;
        const box = avatar.getBoundingClientRect();
        const x = Math.max(-3, Math.min(3, (e.clientX - box.left - box.width / 2) / 8)), y = Math.max(-2, Math.min(2, (e.clientY - box.top - box.height / 2) / 10));
        avatar.style.setProperty('--gaze-x', `${x}px`);
        avatar.style.setProperty('--gaze-y', `${y}px`);
    };
    const leave = e => { const a = e.target.closest?.('.eb-avatar'); if (a) {
        a.style.removeProperty('--gaze-x');
        a.style.removeProperty('--gaze-y');
    } };
    root.addEventListener('pointermove', move, { passive: true });
    root.addEventListener('pointerout', leave, { passive: true });
    document.addEventListener('visibilitychange', update);
    reduced.addEventListener('change', update);
    update();
    return { refresh() { if (dead)
            return; observer?.disconnect(); for (const a of root.querySelectorAll('.eb-avatar'))
            observer?.observe(a); update(); },
        dispose() { dead = true; observer?.disconnect(); root.removeEventListener('pointermove', move); root.removeEventListener('pointerout', leave); document.removeEventListener('visibilitychange', update); reduced.removeEventListener('change', update); } };
}
