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

Saem `lote-01-saude-pronto.csv` (passou em todas as conferências) e
`lote-02-conferir.csv` (com o motivo de cada linha). Critérios: estabelecimento
ativo, com CNPJ (sem CNPJ é pessoa física: não publicamos), coordenada presente,
dentro da área, não repetida em endereços diferentes, perto do bairro informado
e dos outros estabelecimentos da mesma rua, e nome que não seja só de uma pessoa.
