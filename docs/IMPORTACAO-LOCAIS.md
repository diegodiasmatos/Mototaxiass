# Importação de locais (estabelecimentos) na central

Central → 🗺️ Mapas → **Importar planilha de locais**.

1. Escolha um arquivo CSV (separado por `;` ou `,`) com cabeçalho. Colunas:
   **nome**, **latitude**, **longitude** (obrigatórias); opcionais: categoria,
   palavras_chave, logradouro, numero, bairro, fonte, situacao.
2. O sistema **só confere** e mostra uma prévia, linha a linha:
   - **novo**: será cadastrado;
   - **já existe**: mesmo nome já está na base (OpenStreetMap ou cadastro manual);
   - **possível duplicata**: nome parecido a menos de 80 m de um local existente;
   - **repetido na planilha**, **fora da área** (mais de 12 km do centro), **inválido**.
3. Só depois de **Cadastrar** as linhas *novas* são gravadas (numa única
   operação, registrada na auditoria). O que já existe ou parece duplicado
   **nunca** é sobrescrito por aqui.

O cadastro manual (um local por vez) também avisa quando o nome já existe ou há
um local parecido muito perto, e só grava se a central confirmar.

## Endereços oficiais do IBGE (números de casa)

Central → 🗺️ Mapas → **Endereços oficiais do IBGE (CNEFE)**. Baixe o arquivo
do município no IBGE (link na própria tela), descompacte e escolha o `.csv`.
A prévia mostra quantos números de casa, ruas e bairros/loteamentos entram.
Depois de importar, "Rua X, 123" cai no ponto exato da casa. Casas não viram
locais com nome. Nada é sobrescrito: números confirmados por passageiros e
ruas/bairros já existentes ficam como estão, e "Atualizar base" (OSM) não apaga
o que veio do IBGE. Ficam de fora: endereços fora da área atendida (distritos),
posição imprecisa (quadra/setor), tipos de logradouro inválidos e localidades
anotadas de forma livre ("ao lado do ramal…").

## Fontes que podem ser usadas

- **Podem** ser guardadas no VAIRO: OpenStreetMap (licença ODbL, botão
  "Atualizar base") e dados abertos oficiais (CNES/DATASUS, ANP etc.), além do
  que a equipe conferir pessoalmente.
- **Não podem**: conteúdo copiado do Google Maps ou do Mapbox (nomes,
  endereços, coordenadas de lugares). Os termos desses serviços proíbem
  guardar esse conteúdo em outra base, mesmo copiando à mão.

## Gerar lotes a partir das fontes oficiais

```
python3 tools/locais/baixar_fontes.py pasta/ data/assis.db
python3 tools/locais/gerar_lotes.py pasta/
```

Saem `lote-01-pronto.csv` (passou em todas as conferências),
`lote-02-conferir.csv` (com o motivo de cada linha) e
`lote-03-ibge-censo2022-estabelecimentos.csv` (mercados, padarias, lojas,
academias, igrejas, escolas… anotados pelo Censo 2022: confirmar se continuam
abertos). A posição de cada estabelecimento é a do mesmo endereço no IBGE
(anotada no local pelo recenseador); sem o endereço no IBGE, vai para conferir. Critérios: estabelecimento
ativo, com CNPJ (sem CNPJ é pessoa física: não publicamos), coordenada presente,
dentro da área, não repetida em endereços diferentes, perto do bairro informado
e dos outros estabelecimentos da mesma rua, e nome que não seja só de uma pessoa.

## Importação automática (pasta `seed/`)

No app publicado (`APP_ENV=production`), o servidor importa **uma vez**, ao
ligar e depois da atualização do OpenStreetMap, os arquivos da pasta `seed/`:

- `ibge-*.csv` — endereços oficiais do IBGE (CNEFE), pela mesma rotina do cartão
  da central;
- `locais-*.csv` — planilhas de locais já conferidos, pela mesma rotina de
  "Importar planilha de locais".

Cada arquivo fica marcado como importado pela impressão digital dele (não roda
de novo). Se o arquivo mudar, é importado de novo e só o que for novo entra.
Tudo fica na auditoria como "sistema". Para não importar, defina
`SEED_IMPORTS=0`. Coloque em `seed/` só dados **já conferidos**.

Hoje: `ibge-cnefe-2022-4102000-assis-chateaubriand.csv` (IBGE, Censo 2022) e
`locais-lote-01-pronto.csv` (saúde e postos conferidos com o IBGE). O lote de
comércio do Censo 2022 **não** está aqui porque precisa ser conferido antes.

Fontes: IBGE — Cadastro Nacional de Endereços para Fins Estatísticos (CNEFE),
Censo Demográfico 2022; Ministério da Saúde — CNES; ANP — revendedores de
combustíveis.
