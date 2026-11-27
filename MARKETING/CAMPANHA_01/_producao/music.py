"""Trilhas originais da campanha VAIRO (sintetizadas aqui; sem amostras de terceiros)."""
import numpy as np, wave, sys

SR = 44100

def note(n):  # MIDI -> Hz
    return 440.0 * 2 ** ((n - 69) / 12)

def lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x); acc = 0.0
    for i in range(len(x)):
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y

def env(n, a=0.01, r=0.2, total=None):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4))
    rel = np.clip((total - t) / r, 0, 1) if total else 1
    return e * rel

def saw(f, n, detune=0.0):
    t = np.arange(n) / SR
    s = 0
    for d in (-detune, 0, detune):
        s = s + (2 * ((t * f * (1 + d)) % 1) - 1)
    return s / 3

def kick(n=int(0.35 * SR)):
    t = np.arange(n) / SR
    f = 50 + 90 * np.exp(-t * 30)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 9)

def hat(n=int(0.06 * SR), rng=np.random.default_rng(7)):
    x = rng.standard_normal(n)
    x = x - lowpass(x, 6000)
    return x * np.exp(-np.arange(n) / SR * 60) * 0.35

def clap(n=int(0.2 * SR), rng=np.random.default_rng(3)):
    x = rng.standard_normal(n)
    x = lowpass(x - lowpass(x, 900), 5000)
    return x * np.exp(-np.arange(n) / SR * 18) * 0.5

def riser(n, rng=np.random.default_rng(5)):
    x = rng.standard_normal(n)
    t = np.linspace(0, 1, n)
    y = x - lowpass(x, 400)
    return y * t ** 2 * 0.25

def impact(n=int(1.6 * SR)):
    t = np.arange(n) / SR
    f = 40 + 60 * np.exp(-t * 8)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 2.5)
    rng = np.random.default_rng(9)
    nz = lowpass(rng.standard_normal(n), 1500) * np.exp(-t * 6) * 0.6
    return s + nz

def place(buf, x, at, gain=1.0):
    i = int(at * SR)
    if i >= len(buf): return
    m = min(len(x), len(buf) - i)
    buf[i:i + m] += x[:m] * gain

def track(dur, bpm, chords, mood, out):
    n = int(dur * SR)
    L = np.zeros(n); R = np.zeros(n)
    beat = 60 / bpm
    bar = beat * 4
    bars = int(np.ceil(dur / bar))
    for b in range(bars):
        root, triad = chords[b % len(chords)]
        t0 = b * bar
        intro = mood == 'cinema' and b < 2
        build = mood == 'teaser' and b < bars - 3
        # pad
        pn = int(bar * SR) + int(0.4 * SR)
        pad = sum(saw(note(m), pn, 0.004) for m in triad)
        pad = lowpass(pad, 900 if intro else 1600) * env(pn, 0.25, 0.4, pn / SR) * 0.10
        place(L, pad, t0); place(R, pad * 0.95, t0)
        # baixo
        if not intro:
            for k in range(8):
                if mood == 'teaser' and k % 2: continue
                bn = int(beat / 2 * SR * 0.9)
                bs = lowpass(saw(note(root - 24), bn), 300) * env(bn, 0.005, 0.05, bn / SR) * 0.32
                place(L, bs, t0 + k * beat / 2); place(R, bs, t0 + k * beat / 2)
        # bateria
        for k in range(4):
            tb = t0 + k * beat
            if not intro and not (build and k % 2):
                place(L, kick(), tb, 0.75); place(R, kick(), tb, 0.75)
            if not intro and k in (1, 3) and mood != 'teaser':
                place(L, clap(), tb, 0.35); place(R, clap(), tb, 0.35)
            for h in (0, 0.5):
                if intro: continue
                g = 0.5 if h else 0.3
                place(L, hat(), tb + h * beat, g * 0.9); place(R, hat(), tb + h * beat, g)
        # arpejo
        if mood != 'teaser' or b >= bars - 3:
            for k in range(8):
                m = triad[k % 3] + (12 if k >= 4 else 0)
                an = int(beat / 2 * SR)
                a = np.sin(2 * np.pi * note(m + 12) * np.arange(an) / SR) * env(an, 0.003, 0.15, an / SR) * 0.07
                pan = 0.3 + 0.4 * (k % 2)
                place(L, a * (1 - pan), t0 + k * beat / 2); place(R, a * pan, t0 + k * beat / 2)
    # efeitos: subida e impacto nos momentos de marca
    if mood == 'cinema':
        place(L, riser(int(2.0 * SR)), 0.6, 0.8); place(R, riser(int(2.0 * SR)), 0.6, 0.8)
        place(L, impact(), 2.6, 0.9); place(R, impact(), 2.6, 0.9)
        place(L, impact(), dur - 3.6, 0.7); place(R, impact(), dur - 3.6, 0.7)
    if mood == 'teaser':
        rn = int(4 * SR)
        place(L, riser(rn), dur - 7.5, 1.0); place(R, riser(rn), dur - 7.5, 1.0)
        place(L, impact(), dur - 3.6, 1.0); place(R, impact(), dur - 3.6, 1.0)
    if mood == 'tutorial':
        place(L, impact(), dur - 2.6, 0.55); place(R, impact(), dur - 2.6, 0.55)
    # fades e normalização
    fade = np.ones(n)
    fi, fo = int(0.8 * SR), int(1.8 * SR)
    fade[:fi] = np.linspace(0, 1, fi); fade[-fo:] = np.linspace(1, 0, fo)
    L *= fade; R *= fade
    peak = max(np.abs(L).max(), np.abs(R).max())
    L = np.tanh(L / peak * 1.2) * 0.85; R = np.tanh(R / peak * 1.2) * 0.85
    data = np.stack([L, R], 1)
    pcm = (data * 32767).astype('<i2').tobytes()
    with wave.open(out, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm)
    print(out, f'{dur}s')

# Am – F – C – G (raízes em MIDI, tríades)
PROG = [(57, (69, 72, 76)), (53, (65, 69, 72)), (48, (67, 72, 76)), (55, (67, 71, 74))]
PROG2 = [(53, (65, 69, 72)), (55, (67, 71, 74)), (57, (69, 72, 76)), (52, (64, 67, 71))]
out = sys.argv[1]
track(float(sys.argv[2]), 100, PROG, 'cinema', f'{out}/trilha_01.wav')
track(float(sys.argv[3]), 116, PROG2, 'tutorial', f'{out}/trilha_02.wav')
track(float(sys.argv[4]), 92, PROG, 'teaser', f'{out}/trilha_03.wav')
