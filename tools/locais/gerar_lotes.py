"""Monta os lotes de importação a partir de fontes oficiais abertas (CNES e ANP).

Saída (pasta enderecos/):
  lote-01-saude-pronto.csv      → passou em todas as conferências
  lote-02-conferir.csv          → precisa de conferência humana (motivo em "situacao")
  relatorio-lotes.json          → contagens por fonte, bairro e motivo
Critérios (nada é inventado; número/CEP só quando a fonte informa):
  - estabelecimento ativo (CNES sem motivo de desabilitação);
  - com CNPJ (sem CNPJ = pessoa física: não publicamos nome + endereço de pessoas);
  - coordenada presente e dentro da área atendida (12 km do centro);
  - coordenada não compartilhada por estabelecimentos de endereços diferentes
    (sinal de posição genérica);
  - quando o bairro existe na base, o ponto fica a até 2,5 km do centro do bairro.
"""
import csv, json, math, re, sys, unicodedata
from collections import Counter, defaultdict

D = sys.argv[1]
CENTER = (-24.4156, -53.5216); RADIUS = 12000

def norm(s): return unicodedata.normalize('NFD', s or '').encode('ascii', 'ignore').decode().lower().strip()
def dist(a, b):
    R = 6371000; p1, p2 = math.radians(a[0]), math.radians(b[0]); dl = math.radians(b[1] - a[1]); dp = p2 - p1
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))
SIGLAS = {'usf', 'ubs', 'caps', 'sus', 'apae', 'pr', 'ltda', 'me', 'epp', 'ii', 'iii', 'cia', 'sa', 'hiv', 'cer', 'cmo', 'ceo', 'nasf'}
MIN = {'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o'}
def titulo(s):
    out = []
    for i, w in enumerate((s or '').strip().split()):
        lw = w.lower()
        if lw in SIGLAS: out.append(w.upper() if lw not in ('ltda', 'cia') else lw.capitalize())
        elif lw in MIN and i: out.append(lw)
        else: out.append(lw[:1].upper() + lw[1:])
    return re.sub(r'\s+', ' ', ' '.join(out))

base = json.load(open(f'{D}/base-pontos.json'))
bairros = {norm(b['name']): (b['lat'], b['lng']) for b in base if b['kind'] == 'bairro'}
bairros['centro'] = CENTER
def bairro_ponto(nome):
    n = norm(nome).replace('jd.', 'jardim').replace('jd ', 'jardim ')
    if n.startswith('plano piloto') or n == 'centro': return CENTER
    return bairros.get(n)

TIPO_CNES = {
    '1': ('posto de saude', 'ubs posto de saude saude'), '2': ('unidade basica de saude', 'ubs posto de saude saude'),
    '4': ('policlinica', 'clinica policlinica saude'), '5': ('hospital', 'hospital pronto socorro saude'),
    '22': ('consultorio', 'consultorio clinica saude'), '36': ('clinica', 'clinica saude'),
    '39': ('laboratorio / diagnostico', 'laboratorio exames clinica saude'), '43': ('farmacia', 'farmacia drogaria remedio'),
    '70': ('caps', 'caps saude mental'), '74': ('academia da saude', 'academia da saude'),
    '85': ('centro de imunizacao', 'vacina vacinacao imunizacao saude'),
}
EXCLUIR_TIPO = {'68': 'central de gestão (não atende público)', '42': 'unidade móvel (sem endereço fixo)'}

linhas = []   # dicts no formato do importador + situacao
def addr(rua, num, bairro):
    rua = titulo(rua); num = (num or '').strip()
    if num.upper() in ('', '0', '00', '000', 'SN', 'S/N', 'S N'): num = ''
    a = f'{rua}, {num}' if rua and num else rua
    return ' – '.join(x for x in (a, titulo(bairro)) if x), rua, num

# ---------------- CNES ----------------
cnes = json.load(open(f'{D}/cnes-todos.json'))
coord_addr = defaultdict(set)
for x in cnes:
    la, lo = x.get('latitude_estabelecimento_decimo_grau'), x.get('longitude_estabelecimento_decimo_grau')
    if la and lo: coord_addr[(round(la, 4), round(lo, 4))].add((norm(x['endereco_estabelecimento']), (x['numero_estabelecimento'] or '').strip()))
fora = Counter()
for x in cnes:
    t = str(x['codigo_tipo_unidade'])
    nome = titulo(x.get('nome_fantasia') or x.get('nome_razao_social'))
    if x.get('codigo_motivo_desabilitacao_estabelecimento'): fora['desabilitado no CNES'] += 1; continue
    if not x.get('numero_cnpj'): fora['sem CNPJ (pessoa física)'] += 1; continue
    if t in EXCLUIR_TIPO: fora[EXCLUIR_TIPO[t]] += 1; continue
    cat, tags = TIPO_CNES.get(t, ('saude', 'saude'))
    detail, rua, num = addr(x['endereco_estabelecimento'], x['numero_estabelecimento'], x['bairro_estabelecimento'])
    la, lo = x.get('latitude_estabelecimento_decimo_grau'), x.get('longitude_estabelecimento_decimo_grau')
    motivos = []
    if not la or not lo or (abs(la) < 1 and abs(lo) < 1): motivos.append('sem coordenada na fonte')
    else:
        d = dist((la, lo), CENTER)
        if d > RADIUS: motivos.append(f'fora da área atendida ({d/1000:.1f} km do centro): distrito/zona rural')
        if len(coord_addr[(round(la, 4), round(lo, 4))]) > 1: motivos.append('coordenada repetida em endereços diferentes (posição genérica)')
        bp = bairro_ponto(x['bairro_estabelecimento'])
        if bp and dist((la, lo), bp) > 2500: motivos.append(f'ponto a {dist((la, lo), bp)/1000:.1f} km do bairro informado')
    linhas.append({
        'nome': nome, 'categoria': cat, 'palavras_chave': tags, 'logradouro': rua, 'numero': num,
        'bairro': titulo(x['bairro_estabelecimento']), 'cep': x.get('codigo_cep_estabelecimento') or '',
        'latitude': f'{la:.6f}' if la else '', 'longitude': f'{lo:.6f}' if lo else '',
        'fonte': f"CNES/DATASUS (código {x['codigo_cnes']}, atualizado em {x.get('data_atualizacao') or '?'})",
        'situacao': 'pronto' if not motivos else 'conferir: ' + '; '.join(motivos), '_fonte': 'CNES',
    })

# ---------------- ANP (postos) ----------------
anp = json.load(open(f'{D}/anp.json'))['data']
for x in anp:
    detail, rua, num = addr(x['endereco'].split(',')[0], (x['endereco'].split(',') + [''])[1], x['bairro'])
    la, lo = x.get('latitude') or '', x.get('longitude') or ''
    motivos = ['nome é a razão social (confirmar o nome do posto que as pessoas usam)']
    if not la: motivos.append('sem coordenada na fonte')
    else:
        motivos.append('posição marcada pela ANP como "não validada"')
        if dist((float(la), float(lo)), CENTER) > RADIUS: motivos.append('fora da área atendida')
    linhas.append({
        'nome': titulo(x['razaoSocial']), 'categoria': 'posto de combustivel',
        'palavras_chave': f"posto combustivel gasolina etanol {norm(x.get('distribuidora') or '')}".strip(),
        'logradouro': rua, 'numero': num, 'bairro': titulo(x['bairro']), 'cep': x.get('cep') or '',
        'latitude': f'{float(la):.6f}' if la else '', 'longitude': f'{float(lo):.6f}' if lo else '',
        'fonte': f"ANP — revendedores de combustíveis (CNPJ {x['cnpj']})", 'situacao': 'conferir: ' + '; '.join(motivos), '_fonte': 'ANP',
    })

# consistência com a mesma rua: o ponto deve ficar perto dos outros estabelecimentos
# do mesmo logradouro (quando há pelo menos 2 outros com coordenada)
import statistics
por_rua = defaultdict(list)
for l in linhas:
    if l['latitude'] and l['logradouro']: por_rua[norm(re.sub(r'^(rua|avenida|av|r)\.? ', '', norm(l['logradouro'])))].append(l)
for rua, ls in por_rua.items():
    for l in ls:
        outros = [o for o in ls if o is not l]
        if len(outros) < 2: continue
        med = (statistics.median(float(o['latitude']) for o in outros), statistics.median(float(o['longitude']) for o in outros))
        d = dist((float(l['latitude']), float(l['longitude'])), med)
        if d > 600 and l['situacao'] == 'pronto':
            l['situacao'] = f'conferir: ponto a {d:.0f} m dos outros estabelecimentos da mesma rua'

# nome que é só de pessoa (sem palavra de negócio) não ajuda o passageiro e é dado pessoal
NEGOCIO = re.compile(r'clinic|odont|saude|centro|lab|medic|fisio|psic|consult|diagn|imagem|radiol|nutri|farm|drog|hospital|ortop|oftalm|visao|dent|implant|estet|terap|espa|instit|servic|ltda|odonto|vacin|ubs|usf|caps|policl|emagrec|oral', re.I)
for l in linhas:
    if l['_fonte'] == 'CNES' and l['situacao'] == 'pronto' and not NEGOCIO.search(l['nome']):
        l['situacao'] = 'conferir: nome parece ser só de uma pessoa (confirmar o nome do consultório)'

# nomes repetidos dentro do próprio levantamento (ex.: mesma rede em dois endereços)
cnt = Counter(norm(l['nome']) for l in linhas)
for l in linhas:
    if cnt[norm(l['nome'])] > 1 and l['situacao'] == 'pronto':
        l['situacao'] = 'conferir: mesmo nome em mais de um endereço (incluir a unidade/bairro no nome)'

COLS = ['nome', 'categoria', 'palavras_chave', 'logradouro', 'numero', 'bairro', 'cidade', 'estado', 'cep', 'latitude', 'longitude', 'fonte', 'situacao']
def write(path, rows):
    with open(path, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, COLS, delimiter=';', extrasaction='ignore')
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r['bairro'], r['nome'])): w.writerow({**r, 'cidade': 'Assis Chateaubriand', 'estado': 'PR'})
pronto = [l for l in linhas if l['situacao'] == 'pronto']
conferir = [l for l in linhas if l['situacao'] != 'pronto']
write(f'{D}/lote-01-saude-pronto.csv', pronto)
write(f'{D}/lote-02-conferir.csv', conferir)
motivos = Counter(m.strip() for l in conferir for m in l['situacao'][len('conferir: '):].split(';'))
rel = {
    'cnes_total': len(cnes), 'anp_total': len(anp), 'descartados': dict(fora),
    'pronto': len(pronto), 'conferir': len(conferir),
    'pronto_por_categoria': Counter(l['categoria'] for l in pronto), 'pronto_por_bairro': Counter(l['bairro'] for l in pronto),
    'motivos_conferir': motivos,
}
json.dump(rel, open(f'{D}/relatorio-lotes.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(rel, ensure_ascii=False, indent=1))
