"""Baixa as fontes oficiais abertas usadas nos lotes de locais.

Uso:  python3 tools/locais/baixar_fontes.py <pasta-de-saida> <banco-do-vairo.db>
Gera: cnes-todos.json (CNES/DATASUS), anp.json (ANP), base-pontos.json (ruas e
bairros da base do VAIRO, usados só para conferir as coordenadas).
Depois:  python3 tools/locais/gerar_lotes.py <pasta-de-saida>
"""
import json, sqlite3, sys, time, urllib.request

out, dbfile = sys.argv[1], sys.argv[2]
IBGE = '410200'          # Assis Chateaubriand (6 dígitos, como a API do CNES usa)

def get(url):
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=40) as r:
                return json.load(r)
        except Exception:
            time.sleep(3)
    raise SystemExit(f'falhou: {url}')

# CNES: "offset" é o número da página (20 por página)
cnes, page = [], 0
while page < 500:
    e = get(f'https://apidadosabertos.saude.gov.br/cnes/estabelecimentos?codigo_municipio={IBGE}&limit=20&offset={page}').get('estabelecimentos', [])
    if not e: break
    cnes += e; page += 1; time.sleep(0.6)       # sem pressa: respeita o serviço público
json.dump(cnes, open(f'{out}/cnes-todos.json', 'w'), ensure_ascii=False)

anp = get('https://revendedoresapi.anp.gov.br/v1/combustivel?municipio=ASSIS%20CHATEAUBRIAND&uf=PR')
json.dump(anp, open(f'{out}/anp.json', 'w'), ensure_ascii=False)

# IBGE — CNEFE (Censo 2022): todos os endereços do município com coordenadas
import io, os, zipfile
CNEFE = ('https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/Censo_Demografico_2022/'
         'Arquivos_CNEFE/CSV/Municipio/41_PR/4102000_ASSIS_CHATEAUBRIAND.zip')
with urllib.request.urlopen(CNEFE, timeout=300) as r:
    zipfile.ZipFile(io.BytesIO(r.read())).extractall(os.path.join(out, 'cnefe'))

con = sqlite3.connect(f'file:{dbfile}?mode=ro', uri=True)
pts = [dict(zip(('kind', 'name', 'norm', 'lat', 'lng'), r)) for r in con.execute('SELECT kind, name, norm, lat, lng FROM local_addresses')]
json.dump(pts, open(f'{out}/base-pontos.json', 'w'), ensure_ascii=False)
print(f'CNES {len(cnes)} · ANP {len(anp.get("data", []))} · base {len(pts)}')
