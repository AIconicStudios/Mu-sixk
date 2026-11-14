#!/usr/bin/env python3
"""Trains the element-level model from tools/train-elements.js output and writes src/model.js.

For each part (vocals, drums, bass, other) it predicts how loud that part is against the whole mix
(dB, LUFS-based) from the segment features. Ridge regression and a small neural network are both
scored with 5-fold cross-validation grouped by song (a song's remixes never sit in both the training
and the test folds), and the better one per part is shipped. Only numpy is needed.

Usage: python3 tools/train_elements.py <elements.jsonl> [--out src/model.js]
"""
import json
import sys
from pathlib import Path

import numpy as np

PARTS = ["vocals", "drums", "bass", "other"]
FOLDS = 5


def load(path):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
    X = np.array([r["x"] for r in rows], dtype=float)
    groups = np.array([r["track"] for r in rows])
    variant = np.array([r["variant"] for r in rows])
    gains = {p: np.array([r["gains"][p] for r in rows]) for p in PARTS}
    Y = {p: np.array([np.nan if r["y"][p] is None else r["y"][p] for r in rows]) for p in PARTS}
    return X, groups, variant, gains, Y


def ridge_fit(X, y, lam):
    A = np.hstack([X, np.ones((len(X), 1))])
    reg = lam * np.eye(A.shape[1])
    reg[-1, -1] = 0
    w = np.linalg.solve(A.T @ A + reg, A.T @ y)
    return {"type": "ridge", "w": w[:-1], "b": w[-1]}


def mlp_fit(X, y, hidden=16, l2=1e-3, epochs=1500, lr=0.01, seed=0):
    rng = np.random.default_rng(seed)
    n, d = X.shape
    W1 = rng.normal(0, 1 / np.sqrt(d), (d, hidden)); b1 = np.zeros(hidden)
    W2 = rng.normal(0, 1 / np.sqrt(hidden), hidden); b2 = float(np.mean(y))
    params = [W1, b1, W2, np.array([b2])]
    m = [np.zeros_like(p) for p in params]; v = [np.zeros_like(p) for p in params]
    for step in range(1, epochs + 1):
        W1, b1, W2, b2 = params
        H = np.tanh(X @ W1 + b1)
        err = H @ W2 + b2[0] - y
        g_out = err / n
        gW2 = H.T @ g_out + l2 * W2
        gb2 = np.array([g_out.sum()])
        gH = np.outer(g_out, W2) * (1 - H ** 2)
        gW1 = X.T @ gH + l2 * W1
        gb1 = gH.sum(axis=0)
        for i, g in enumerate([gW1, gb1, gW2, gb2]):
            m[i] = 0.9 * m[i] + 0.1 * g
            v[i] = 0.999 * v[i] + 0.001 * g * g
            params[i] = params[i] - lr * (m[i] / (1 - 0.9 ** step)) / (np.sqrt(v[i] / (1 - 0.999 ** step)) + 1e-8)
    W1, b1, W2, b2 = params
    return {"type": "mlp", "W1": W1, "b1": b1, "W2": W2, "b2": float(b2[0])}


def predict(model, X):
    if model["type"] == "ridge":
        return X @ model["w"] + model["b"]
    if model["type"] == "ensemble":
        return np.mean([predict(m, X) for m in model["members"]], axis=0)
    return np.tanh(X @ model["W1"] + model["b1"]) @ model["W2"] + model["b2"]


KINDS = ["ridge 10", "ridge 30", "ridge 100", "mlp"]


def fit(kind, X, y):
    if kind.startswith("ridge"):
        return ridge_fit(X, y, float(kind.split()[1]))
    return {"type": "ensemble", "members": [mlp_fit(X, y, hidden=8, l2=0.2, epochs=600, seed=s) for s in range(3)]}


def cross_validate(kind, X, y, groups):
    tracks = np.unique(groups)
    rng = np.random.default_rng(7)
    rng.shuffle(tracks)
    fold_of = {t: i % FOLDS for i, t in enumerate(tracks)}
    folds = np.array([fold_of[g] for g in groups])
    pred = np.full(len(y), np.nan)
    for f in range(FOLDS):
        tr, te = folds != f, folds == f
        mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
        model = fit(kind, (X[tr] - mu) / sd, y[tr])
        pred[te] = predict(model, (X[te] - mu) / sd)
    return pred


def flag_rates(pred, variant, gain, pro_pred):
    """False alarms on untouched pro mixes, and how often a part pushed 4.5+ dB off is flagged the right way."""
    out = {}
    for name, q in [("lean", 10), ("judge", 5)]:
        lo, hi = np.percentile(pro_pred, q), np.percentile(pro_pred, 100 - q)
        pro = variant == 0
        down, up = (gain <= -4.5) & ~pro, (gain >= 4.5) & ~pro
        out[name] = {
            "falseAlarm": round(float(np.mean((pred[pro] < lo) | (pred[pro] > hi))), 3),
            "catchQuiet": round(float(np.mean(pred[down] < lo)), 3) if down.any() else None,
            "catchLoud": round(float(np.mean(pred[up] > hi)), 3) if up.any() else None,
        }
    return out


def to_js(model):
    def arr(a):
        return [round(float(v), 5) for v in np.ravel(a)]
    if model["type"] == "ridge":
        return {"type": "ridge", "w": arr(model["w"]), "b": round(float(model["b"]), 5)}
    return {"type": "ensemble", "members": [
        {"type": "mlp", "hidden": len(m["b1"]), "W1": arr(m["W1"]), "b1": arr(m["b1"]), "W2": arr(m["W2"]), "b2": round(m["b2"], 5)}
        for m in model["members"]]}


def main():
    src = sys.argv[1]
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else Path(__file__).resolve().parent.parent / "src" / "model.js"
    X, groups, variant, gains, Y = load(src)
    mu, sd = X.mean(0), X.std(0) + 1e-9
    shipped = {}
    for p in PARTS:
        ok = ~np.isnan(Y[p])
        x, y, g = X[ok], Y[p][ok], groups[ok]
        base = np.mean(np.abs(y - np.mean(y)))
        scores = {}
        preds = {}
        for kind in KINDS:
            preds[kind] = cross_validate(kind, x, y, g)
            scores[kind] = float(np.mean(np.abs(preds[kind] - y)))
        best = min(scores, key=scores.get)
        pred = preds[best]
        # Can it tell a part that was pushed 4+ dB away from the song's own pro balance, and which way?
        orig = {t: yy for t, yy, vv in zip(g, y, variant[ok]) if vv == 0}
        moved = np.array([abs(gn) >= 4 and t in orig for t, gn in zip(g, gains[p][ok])])
        typical = np.median([orig[t] for t in orig])
        direction = np.mean(np.sign(pred[moved] - typical) == np.sign(gains[p][ok][moved])) if moved.any() else float("nan")
        corr = float(np.corrcoef(pred, y)[0, 1])
        pro = np.array(list(orig.values()))
        # How the model itself rates untouched professional mixes (its own error included): the range to judge against.
        pro_pred = pred[variant[ok] == 0]
        listing = " | ".join(f"{k} {v:.2f}" for k, v in scores.items())
        print(f"         flags: {flag_rates(pred, variant[ok], gains[p][ok], pred[variant[ok] == 0])}")
        print(f"{p:7s} n={len(y):4d}  baseline MAE {base:.2f} dB | {listing} -> {best}"
              f" | r={corr:.2f} | right direction when moved 4+ dB: {direction * 100:.0f}% (n={moved.sum()})")
        model = fit(best, (x - mu) / sd, y)
        shipped[p] = {
            "model": to_js(model), "cvMae": round(scores[best], 2), "baselineMae": round(float(base), 2),
            "direction": round(float(direction), 3), "r": round(corr, 3),
            "pro": {"lo": round(float(np.percentile(pro, 10)), 1), "mid": round(float(np.median(pro)), 1), "hi": round(float(np.percentile(pro, 90)), 1), "n": int(len(pro))},
            "judge": {"lo": round(float(np.percentile(pro_pred, 5)), 1), "mid": round(float(np.median(pro_pred)), 1), "hi": round(float(np.percentile(pro_pred, 95)), 1)},
            "lean": {"lo": round(float(np.percentile(pro_pred, 10)), 1), "hi": round(float(np.percentile(pro_pred, 90)), 1)},
            "flags": flag_rates(pred, variant[ok], gains[p][ok], pro_pred),
        }
    body = {"source": "MUSDB18 7-second excerpts, 10 remixes per song", "songs": int(len(np.unique(groups))),
            "mean": [round(float(v), 5) for v in mu], "std": [round(float(v), 5) for v in sd], "parts": shipped}
    out.write_text(
        "/* Generated by tools/train_elements.py: element-level model trained on remixes of real songs.\n"
        "   Weights only; no audio from the dataset is included. */\n"
        "(function (root) {\n  'use strict';\n  const M = (root.MuSixk = root.MuSixk || {});\n"
        f"  M.model = {json.dumps(body, separators=(',', ':'))};\n"
        "})(typeof self !== 'undefined' ? self : globalThis);\n")
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
