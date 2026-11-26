"""Monta os lotes de importação a partir de fontes oficiais abertas.

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

# ---------------- cruzamento com o IBGE (CNEFE, Censo 2022) ----------------
# A posição do CNEFE foi anotada no local pelo recenseador. Se o mesmo endereço
# (rua + número) existe no CNEFE, o estabelecimento fica na posição do IBGE.
import os
CNEFE_FILE = os.path.join(D, 'cnefe', '4102000_ASSIS_CHATEAUBRIAND.csv')
TIPOS_RUA = r'^(rua|r|avenida|av|travessa|tv|alameda|rodovia|rod|estrada|praca|pca)\.?\s+'
ABREV = {'d': 'dom', 'pres': 'presidente', 'mal': 'marechal', 'dr': 'doutor', 'sta': 'santa', 'sto': 'santo', 'xv': 'quinze', 'prof': 'professor', 'gov': 'governador', 'cel': 'coronel', 'gal': 'general', 'pe': 'padre'}
def nucleo(rua):
    n = norm(rua).replace('.', ' ')
    n = re.sub(TIPOS_RUA, '', n)
    return ' '.join(ABREV.get(w, w) for w in n.split())
cnefe_idx = {}; cnefe_estab = []
if os.path.exists(CNEFE_FILE):
    for r in csv.DictReader(open(CNEFE_FILE, encoding='latin-1'), delimiter=';'):
        if r['NV_GEO_COORD'] not in ('1', '2', '3'): continue
        k = (nucleo(' '.join(x for x in (r['NOM_TITULO_SEGLOGR'], r['NOM_SEGLOGR']) if x)), r['NUM_ENDERECO'].lstrip('0'))
        cnefe_idx.setdefault(k, []).append(r)
        if r['DSC_ESTABELECIMENTO'].strip(): cnefe_estab.append(r)
def cnefe_lookup(rua, num):
    n = (num or '').strip().lstrip('0')
    if not n or not n.isdigit(): return None
    return cnefe_idx.get((nucleo(rua), n))
cruzados = Counter()
for l in linhas:
    hit = cnefe_lookup(l['logradouro'], l['numero'])
    if not hit:
        cruzados['sem o endereço no IBGE'] += 1
        if l['situacao'] == 'pronto':
            l['situacao'] = 'conferir: endereço não encontrado no IBGE para confirmar a posição'
        continue
    h = hit[0]
    if l['latitude']:
        d = dist((float(l['latitude']), float(l['longitude'])), (float(h['LATITUDE']), float(h['LONGITUDE'])))
        cruzados['posição corrigida pelo IBGE (> 100 m)' if d > 100 else 'posição confirmada pelo IBGE'] += 1
    else:
        cruzados['posição obtida do IBGE (fonte sem coordenada)'] += 1
    l['latitude'], l['longitude'] = f"{float(h['LATITUDE']):.6f}", f"{float(h['LONGITUDE']):.6f}"
    l['fonte'] += ' · posição do endereço: IBGE/CNEFE 2022'
    # postos: o recenseador costuma anotar o nome que as pessoas usam
    if l['_fonte'] == 'ANP':
        nomes = [x['DSC_ESTABELECIMENTO'] for x in hit if 'POSTO' in x['DSC_ESTABELECIMENTO'].upper()]
        if nomes:
            l['nome'] = titulo(nomes[0])
            l['situacao'] = 'pronto' if dist((float(l['latitude']), float(l['longitude'])), CENTER) <= RADIUS else 'conferir: fora da área atendida'
        else:
            l['situacao'] = 'conferir: nome é a razão social (confirmar o nome do posto que as pessoas usam)'
    elif l['situacao'].startswith('conferir:') and all(
        m.strip().startswith(('coordenada repetida', 'ponto a', 'sem coordenada', 'endereço não encontrado')) for m in l['situacao'][9:].split(';')):
        # o único problema era a posição, e o IBGE resolveu
        l['situacao'] = 'pronto'

# ---------------- estabelecimentos anotados pelo Censo 2022 ----------------
CATS = [
    ('mercado', r'\b(supermercado|mercado|mercearia|atacad|hortifruti|sacolao|acougue|frutaria)', 'mercado supermercado mercearia'),
    ('padaria', r'\b(padaria|panificadora|confeitaria|panifica)', 'padaria panificadora pao'),
    ('academia', r'\b(academia|crossfit|fitness|pilates)', 'academia ginastica'),
    ('posto de combustivel', r'\bposto\b(?! de saude)', 'posto combustivel gasolina'),
    ('farmacia', r'\b(farmacia|drogaria)', 'farmacia drogaria remedio'),
    ('restaurante', r'\b(restaurante|lanchonete|pizzaria|churrascaria|pastelaria|sorveteria|lanches|cafe|bar e)', 'restaurante lanchonete comida'),
    ('igreja', r'\b(igreja|capela|paroquia|templo|congregacao|assembleia de deus|tabernaculo|comunidade evangelica|ministerio)', 'igreja templo'),
    ('escola', r'\b(escola|colegio|creche|cmei|instituto federal|faculdade|universidade|centro de educacao)', 'escola colegio educacao'),
    ('loja', r'\b(loja|magazine|calcados|confeccoes|moveis|eletro|materiais de construcao|ferragens|papelaria|otica|presentes|variedades|autopecas|auto pecas)', 'loja comercio'),
    ('banco', r'\b(banco|sicredi|sicoob|cresol|caixa economica|bradesco|itau|santander|cooperativa de credito)', 'banco agencia caixa eletronico'),
    ('hotel', r'\b(hotel|pousada)', 'hotel pousada'),
]
GENERICO = re.compile(r'^(galpao|barracao|deposito|garagem|comercio|loja|igreja|escola|mercado|bar|oficina|salao|predio|sala|sala comercial|ponto comercial|estabelecimento|empresa)\b(?!\s+\w)', re.I)
lote3 = []; vistos = []
# anotações que não são o estabelecimento em si, ou que enganam a categoria
EXCLUIR = re.compile(r'\b(deposito|administrativo|depto|departamento|dependencias|wcs?|banheiro|almoxarifado|barracao|galpao|garagem|estacionamento|em construcao)\b|desativad|fechad|inativ|molas')
RECATEG = [(re.compile(r'\bauto ?escola'), ('autoescola', 'auto escola habilitacao cnh')),
           (re.compile(r'\b(bombeiro|brigada)'), ('orgao publico', 'bombeiros')),
           (re.compile(r'\batacadista medicamentos|distribuidora de medicamentos'), None)]
SO_CATEGORIA = re.compile(r'^(padaria|panificadora|academia|igreja|capela|escola|creche|mercado|mercearia|supermercado|loja|bar|lanchonete|restaurante|farmacia|drogaria|posto|posto de combustivel|posto de gasolina|hotel|banco|templo|academia de ginastica|confeitaria|studio fitness|studio de pilates)$')
for r in cnefe_estab:
    nome = re.sub(r'\s+', ' ', r['DSC_ESTABELECIMENTO']).strip()
    nn = norm(nome)
    if EXCLUIR.search(nn) or SO_CATEGORIA.match(nn): continue
    cat = next((c for c in CATS if re.search(c[1], nn)), None)
    for rx, nova in RECATEG:
        if rx.search(nn): cat = (nova[0], '', nova[1]) if nova else None; break
    if not cat: continue
    lat, lng = float(r['LATITUDE']), float(r['LONGITUDE'])
    if dist((lat, lng), CENTER) > RADIUS: continue
    if any(v[0] == nn and dist((lat, lng), (v[1], v[2])) < 80 for v in vistos): continue
    vistos.append((nn, lat, lng))
    mot = ['estabelecimento anotado no Censo 2022: confirmar se continua aberto e o nome atual']
    if GENERICO.match(nn) or len(nn) < 6: mot.insert(0, 'nome genérico')
    if len(nome) >= 40: mot.append('nome cortado em 40 letras pelo Censo')
    num = r['NUM_ENDERECO'] if r['NUM_ENDERECO'] not in ('0', '') else ''
    lote3.append({
        'nome': titulo(nome), 'categoria': cat[0], 'palavras_chave': cat[2],
        'logradouro': titulo(' '.join(x for x in (r['NOM_TIPO_SEGLOGR'], r['NOM_TITULO_SEGLOGR'], r['NOM_SEGLOGR']) if x)),
        'numero': num, 'bairro': titulo(r['DSC_LOCALIDADE']), 'cep': r['CEP'],
        'latitude': f'{lat:.6f}', 'longitude': f'{lng:.6f}',
        'fonte': 'IBGE — CNEFE, Censo Demográfico 2022', 'situacao': 'conferir: ' + '; '.join(mot), '_fonte': 'CNEFE',
    })

COLS = ['nome', 'categoria', 'palavras_chave', 'logradouro', 'numero', 'bairro', 'cidade', 'estado', 'cep', 'latitude', 'longitude', 'fonte', 'situacao']
def write(path, rows):
    with open(path, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, COLS, delimiter=';', extrasaction='ignore')
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r['bairro'], r['nome'])): w.writerow({**r, 'cidade': 'Assis Chateaubriand', 'estado': 'PR'})
pronto = [l for l in linhas if l['situacao'] == 'pronto']
conferir = [l for l in linhas if l['situacao'] != 'pronto']
write(f'{D}/lote-01-pronto.csv', pronto)
write(f'{D}/lote-02-conferir.csv', conferir)
write(f'{D}/lote-03-ibge-censo2022-estabelecimentos.csv', lote3)
motivos = Counter(m.strip() for l in conferir for m in l['situacao'][len('conferir: '):].split(';'))
rel = {
    'cnes_total': len(cnes), 'anp_total': len(anp), 'descartados': dict(fora),
    'pronto': len(pronto), 'conferir': len(conferir),
    'pronto_por_categoria': Counter(l['categoria'] for l in pronto), 'pronto_por_bairro': Counter(l['bairro'] for l in pronto),
    'motivos_conferir': motivos,
    'cruzamento_ibge': cruzados,
    'lote3_total': len(lote3), 'lote3_por_categoria': Counter(l['categoria'] for l in lote3),
    'lote3_nome_generico': sum(1 for l in lote3 if 'nome genérico' in l['situacao']),
}
json.dump(rel, open(f'{D}/relatorio-lotes.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(rel, ensure_ascii=False, indent=1))
