// Timeline helpers for film.js. Every value here is a pure function of the time passed in.
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const inv = (a, b, x) => clamp((x - a) / (b - a));

export const E = {
  lin: x => x,
  smooth: x => x * x * (3 - 2 * x),
  smoother: x => x * x * x * (x * (x * 6 - 15) + 10),
  out: x => 1 - Math.pow(1 - x, 3),
  out4: x => 1 - Math.pow(1 - x, 4),
  in: x => x * x * x,
  inOut: x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  inOutQuint: x => (x < 0.5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2),
  // a landing with a small overshoot
  pop: x => { const c = 1.9; return x >= 1 ? 1 : 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); }
};

/** Piecewise keys [[t, v, ease?], ...]; v may be a number or an array. Each segment eases with its own ease (smoother by default). */
export function keys(t, ks, ease = E.smoother) {
  if (t <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    if (t <= ks[i][0]) {
      const [t0, v0] = ks[i - 1], [t1, v1, e] = ks[i];
      const u = (e || ease)((t - t0) / (t1 - t0));
      return Array.isArray(v0) ? v0.map((x, j) => lerp(x, v1[j], u)) : lerp(v0, v1, u);
    }
  }
  return ks[ks.length - 1][1];
}

/** The part of `s` typed by time t, starting at a, at cps characters per second. */
export function typed(s, t, a, cps) {
  const chars = [...s];
  return chars.slice(0, clamp(Math.floor((t - a) * cps), 0, chars.length)).join('');
}
export const caretOn = (t, rate = 1.1) => Math.floor(t * rate * 2) % 2 === 0;

/** Sets styles; x/y/z/s/sx/sy/r/rx/ry compose one transform. Numbers become px except opacity and zIndex. */
export function css(el, o) {
  let tf = false;
  for (const k in o) {
    if (['x', 'y', 'z', 's', 'sx', 'sy', 'r', 'rx', 'ry'].includes(k)) { tf = true; continue; }
    const v = o[k];
    el.style[k] = typeof v === 'number' && k !== 'opacity' && k !== 'zIndex' ? `${v}px` : v;
  }
  if (tf) {
    // 2D unless a 3D move is asked for: a 3D transform forces a compositing layer, and Chromium keeps a layer's
    // first raster scale, so the same frame would come out differently depending on which frames came before it
    const sx = o.sx ?? o.s ?? 1, sy = o.sy ?? o.s ?? 1, is3d = o.z || o.rx || o.ry;
    el.style.transform = (is3d ? `translate3d(${(o.x ?? 0).toFixed(2)}px,${(o.y ?? 0).toFixed(2)}px,${(o.z ?? 0).toFixed(2)}px)` : `translate(${(o.x ?? 0).toFixed(2)}px,${(o.y ?? 0).toFixed(2)}px)`) +
      (o.rx ? ` rotateX(${o.rx.toFixed(3)}deg)` : '') + (o.ry ? ` rotateY(${o.ry.toFixed(3)}deg)` : '') +
      (o.r ? ` rotate(${o.r.toFixed(3)}deg)` : '') + ` scale(${sx.toFixed(4)},${sy.toFixed(4)})`;
  }
}

export function h(tag, cls, html, parent) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  if (parent) parent.appendChild(el);
  return el;
}
