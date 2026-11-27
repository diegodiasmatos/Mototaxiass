# Como refazer as peças

1. Suba o app localmente com a base oficial (`SEED_IMPORTS=1`) e as tarifas de produção.
2. `capture.cjs`: telas reais em alta. `rec.cjs`: gravações de tela (screencast do Chrome, com o tempo de cada quadro).
3. `music.py <pasta> 24 32 22`: trilhas originais (WAV).
4. `render.cjs studio/videoN.html <pasta-de-quadros>`: renderiza quadro a quadro (30 fps). Junte com:
   `ffmpeg -framerate 30 -i quadros/%05d.jpg -i trilha.wav -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 18 -c:a aac -b:a 192k -af loudnorm=I=-14:TP=-1.5 -shortest -movflags +faststart saida.mp4`
5. Imagens: `render.cjs "studio/imgN.html?f=post" saida.png --size 1080x1350` (ou `f=story` e `--size 1080x1920`).

As composições usam as telas em `../TELAS_REAIS` (copie para `studio/`) e as gravações em `studio/clips/` (refaça com `rec.cjs`).
