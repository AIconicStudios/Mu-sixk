/* Mu-sixk element levels: runs the trained model (src/model.js) on segment features to estimate how loud
   the vocals, drums, bass and other instruments sit inside a finished mix. */
(function (root) {
  'use strict';
  const M = (root.MuSixk = root.MuSixk || {});

  function run(model, z) {
    if (model.type === 'ridge') {
      let s = model.b;
      for (let i = 0; i < z.length; i++) s += model.w[i] * z[i];
      return s;
    }
    if (model.type === 'ensemble') return model.members.reduce((sum, m) => sum + run(m, z), 0) / model.members.length;
    const h = model.hidden;
    let out = model.b2;
    for (let j = 0; j < h; j++) {
      let a = model.b1[j];
      for (let i = 0; i < z.length; i++) a += z[i] * model.W1[i * h + j];
      out += Math.tanh(a) * model.W2[j];
    }
    return out;
  }

  function predict(x) {
    const m = M.model;
    if (!m || !x || x.length !== m.mean.length) return null;
    const z = x.map((v, i) => (v - m.mean[i]) / m.std[i]);
    const out = {};
    for (const [part, spec] of Object.entries(m.parts)) out[part] = run(spec.model, z);
    return out;
  }

  /* Median over segments, so one odd section doesn't swing the whole estimate. */
  function combine(list) {
    const ok = list.filter(Boolean);
    if (!ok.length) return null;
    const out = {};
    for (const part of Object.keys(ok[0])) {
      const vals = ok.map((p) => p[part]).sort((a, b) => a - b);
      out[part] = vals.length % 2 ? vals[(vals.length - 1) / 2] : 0.5 * (vals[vals.length / 2 - 1] + vals[vals.length / 2]);
    }
    return out;
  }

  M.elements = { predict, combine };
})(typeof self !== 'undefined' ? self : globalThis);
