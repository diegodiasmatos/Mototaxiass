
# VAIRO Street

**VAIRO — a cidade no seu ritmo.** Plataforma de transporte de passageiros por
motocicleta (antes "Assis MotoTáxi"), em operação em **Assis Chateaubriand – PR**:
aplicativo do passageiro, painel do motorista e central administrativa, com
mapas reais, GPS em tempo real, tarifas calculadas no servidor e comissão
automática de 15%.

## Como executar

Requisito único: **Node.js 24+** (sem npm install — zero dependências).

```bash
cd assis-mototaxi
copy .env.example .env     # opcional, mas recomendado (defina ADMIN_EMAIL/ADMIN_PASSWORD)
node server/index.ts       # ou: npm start
```

Acesse:

| Área | URL |
|---|---|
| Visão Geral (entrada do site) | http://localhost:8780/ |
| Passageiro | http://localhost:8780/passageiro |
| Motorista | http://localhost:8780/motorista |
| Empresa (ainda sem funções — página "em breve") | http://localhost:8780/empresa |
| Central administrativa | http://localhost:8780/admin |

Quem já está conectado e abre `/` cai direto no próprio aplicativo (passageiro
no app, motorista em `/motorista`, administrador em `/admin`); visitante vê a
Visão Geral.

Para testar no celular, use o IP da máquina na mesma rede Wi-Fi
(ex.: `http://192.168.0.10:8780`).
⚠️ O GPS do navegador (geolocalização) só funciona em `localhost` **ou HTTPS** —
em produção coloque o app atrás de HTTPS (ver "Publicação").

### Primeiro administrador

- Se `ADMIN_EMAIL`/`ADMIN_PASSWORD` estiverem no `.env`, o admin é criado com eles.
- Caso contrário, na primeira execução é criado `admin@assismototaxi.local`
  com **senha aleatória impressa uma única vez no console** — anote-a.
- Não existe cadastro público de administrador.

## Visual VAIRO

O visual segue a referência do projeto VAIRO: tema escuro (`#090909`), cartões
`#17171d`, amarelo neon (`#dcf302` / `#e7ff00`) e verde (`#85df01`) nas ações da
área do Motorista. Tudo está em `public/css/app.css`, por variáveis CSS.

- **Cabeçalho comum** (`initChrome` em `public/js/common.js`): marca, áreas
  *Visão Geral · Passageiro · Motorista · Empresa* e botão de tema
  (escuro/claro, guardado no aparelho). Em telas estreitas as áreas somem do
  cabeçalho; o logotipo leva à Visão Geral.
- **Submenu de telas** (`setupScreenMenu`): o seletor "Tela N de M" de cada área
  lista as telas da referência. As que já existem navegam de verdade; as que
  dependem de estado (ex.: "Viagem Ativa" sem corrida) avisam o motivo; as que
  ainda não existem no sistema ficam desabilitadas como "em breve".
- **Fonte e ícones no próprio app**: Inter (`public/fonts/`, licença OFL) e
  ícones do Font Awesome Free (`public/js/icons.js`, CC BY 4.0) — sem CDN,
  funcionam offline.
- **Ícones de instalação**: `node tools/make-icons.ts` regenera os PNG.

O que ainda **não existe** e por isso aparece só como "em breve": a área
Empresa (lojas, cardápio, pedidos), a Vitrine de Lojas e o Carrinho no app do
passageiro, e a Central de Segurança/SOS.

## Arquitetura

| Camada | Tecnologia | Por quê |
|---|---|---|
| Backend | Node 24 + TypeScript nativo (sem build) | simples, estável, sem toolchain |
| Banco | SQLite (`node:sqlite`) com migrações versionadas | persistente, zero instalação, WAL |
| Tempo real | Server-Sent Events (SSE) | ofertas de corrida, GPS e notificações ao vivo |
| Mapas | **Mapbox GL JS** quando há token; Leaflet + OpenStreetMap como reserva | mapa vetorial rápido e nítido no celular; a reserva mantém o sistema funcionando sem custo |
| Rotas/ETA | **Mapbox Directions API** → OSRM → estimativa | rota real por ruas, com a procedência marcada |
| Endereços | **Base local** (todas as ruas da cidade importadas do OSM) → Mapbox Geocoding → Nominatim | autocomplete instantâneo de ruas, números, bairros e estabelecimentos |
| Senhas | scrypt + salt (node:crypto) | hash forte, sem texto puro |
| Sessões | cookie HttpOnly + tabela `sessions` | revogável no servidor (bloqueio derruba sessão) |

## Mapas com Mapbox

### O que é usado

| Recurso do Mapbox | Onde | Para quê |
|---|---|---|
| **Mapbox GL JS** | navegador | mapa visual do passageiro e do mototaxista (pinos, rota, GPS ao vivo) |
| **Directions API** | servidor | rota real por ruas; distância e tempo que alimentam a tarifa |
| **Geocoding API (v6)** | servidor | busca de endereços e coordenada → endereço (GPS, toque no mapa) |

### Configurar (central → 🗺️ Mapas)

1. Crie a conta em [account.mapbox.com](https://account.mapbox.com/).
2. Em **Tokens**, copie o **Default public token** (começa com `pk.`) ou crie
   um novo.
3. Cole em central → 🗺️ Mapas → **Token público** → **Salvar**. Ele fica
   cifrado no banco. (Alternativa para deploy automatizado: variável
   `MAPBOX_PUBLIC_TOKEN` — ver `.env.example`.)
4. **Testar agora**: o sistema confere o token e faz uma chamada real de rota,
   de busca e de endereço por GPS no centro da cidade atendida, dizendo item
   por item o que funcionou. Faça isso antes de divulgar o aplicativo.

Sem token, tudo continua funcionando em **OpenStreetMap/OSRM** — mapa real e
gratuito. A central mostra qual provedor está ativo em cada camada, e a opção
**"Forçar OpenStreetMap"** desliga o Mapbox sem apagar o token.

### Um token basta; dois é mais seguro

- **Token público (`pk.`)** — vai no `/api/config` para o navegador desenhar o
  mapa; é público por natureza. Recomendado: em **URL restrictions** do token,
  informe o endereço do seu site, para ninguém usá-lo em outro lugar.
- **Token de servidor (opcional)** — só é necessário se o token público tiver
  restrição de URL: as chamadas de rota e de busca partem do backend, sem
  referenciador, e seriam recusadas (403). Crie um segundo token **sem**
  restrição de URL e cole em "Token de servidor". Ele **nunca** sai do backend.

O campo do token público **recusa tokens secretos** (`sk.`), e há testes
automatizados garantindo que o token de servidor não aparece em nenhuma
resposta ao frontend.

### Estilo do mapa

Na mesma tela dá para escolher entre **Ruas** (padrão), **Navegação** (ruas em
destaque) e **Satélite com ruas** — útil em bairros onde as ruas ainda não
estão bem mapeadas e o passageiro marca o ponto pela imagem.

### Base local de endereços (sem token e sem custo)

A busca de endereços **não depende** do Mapbox nem do Nominatim online: a
central → 🗺️ Mapas tem o botão **"Baixar base de endereços"**, que importa do
OpenStreetMap (Overpass) **todas as ruas, bairros e estabelecimentos** do
município para a tabela `local_addresses`. A partir daí o autocomplete é
local: instantâneo, completo e funciona até sem internet externa.

- Entende número de casa ("rua curitiba 123"). A posição vem, nesta ordem:
  ponto **confirmado** (OSM ou por um passageiro), **interpolação** entre dois
  números conhecidos da rua, ou centro da rua — e nesse último caso o app
  **pede o ajuste do pino no mapa** antes da corrida, nunca aceita um ponto
  errado em silêncio. O ajuste é **gravado**: a próxima busca daquele número,
  por qualquer pessoa, já acerta direto ("nº confirmado ✅");
- entende abreviações ("av brasil" → "Avenida Brasil") e ignora acentos;
- **tolera erro de digitação** ("av tupanssi" acha a "Avenida Tupassi");
- **busca por categoria**: "hospital" lista hospitais e UBSs, "posto" acha
  postos de gasolina, "mercado" acha supermercados — mesmo sem a palavra no
  nome (palavras-chave derivadas das categorias do OSM);
- o reverse geocoding usa a rua mais próxima da base quando os serviços
  externos falham, sempre sinalizado como "Perto de … (±N m)";
- recomendado refazer a importação a cada ~6 meses para pegar ruas novas.

**Estabelecimentos cadastrados à mão** (central → 🗺️ Mapas): o OSM não conhece
todo comércio de cidade pequena — o administrador cadastra "Mercado Lorena",
"Advocacia Fulano" etc. com nome, palavras-chave e localização (por endereço
de referência ou colando coordenadas). Aparece na busca na hora e sobrevive
às reimportações da base.

Ordem da busca: **base local → Mapbox Geocoding (se houver token) → Nominatim**.
Qualquer resultado da base responde na hora, sem chamada externa — é o que
mantém a busca em milissegundos. A busca no Mapbox é limitada à caixa da área
de cobertura, então a rua de mesmo nome do município vizinho não aparece.

### Rotas (e quando não dá)

O Mapbox **não tem perfil de motocicleta**: a rota usa o perfil `driving`, que
segue as mesmas ruas e mãos de direção. A tela de preço mostra a procedência —
`rota por ruas` ou `distância estimada` — e ela fica gravada em cada cotação e
corrida (`route_provider`, `route_mode`), aparecendo na central em "Rotas
calculadas por procedência".

### Custos e como eles são contidos

O Mapbox tem franquia gratuita mensal para carregamentos de mapa, rotas e
buscas (confira os limites atuais na página de preços da sua conta). O sistema
gasta o mínimo dela:

- a **base local** responde a maior parte das buscas sem chamar o Mapbox;
- o autocomplete só dispara **450 ms depois** que o usuário para de digitar;
- rotas idênticas (mesma origem/destino arredondados) saem do **cache
  persistente** (`geo_cache`), com validade configurável na central (padrão
  72 h); a central mostra quantas chamadas o cache já evitou;
- o mapa da tela de preço é **reaproveitado** entre cotações (cada mapa criado
  conta como um carregamento).

Os resultados de **busca e de endereço por GPS não são guardados em cache**: os
termos do Mapbox proíbem armazenar respostas do modo temporário (o gratuito)
da Geocoding API.

### Falhas tratadas

| Situação | O que acontece |
|---|---|
| Token inválido, revogado ou domínio fora da restrição de URL | o app avisa e **recria os mapas no OpenStreetMap** sem quebrar |
| Mapbox lento ou fora do ar | tempo limite de 9 s no carregamento e 6–8 s por chamada; cai para OSRM/Nominatim |
| Aparelho sem WebGL | o mapa é desenhado pelo Leaflet/OpenStreetMap |
| Nada responde | distância estimada, sempre marcada como estimativa |
| Service worker | **não intercepta** requisições do Mapbox (ele gerencia o próprio cache) |

### Estrutura

```
server/          backend (TypeScript puro)
  index.ts       HTTP, roteamento, estáticos, SSE, bootstrap do admin
  db.ts          schema + migrações + configurações
  auth.ts        registro, login, Google (opcional), sessões, perfis
  rides.ts       cotações, corridas, despacho, cancelamento, avaliações, chat
  drivers.ts     cadastro com documentos, aprovação, online/GPS, ganhos
  admin.ts       dashboard, aprovações, tarifas, auditoria, suporte
  fares.ts       cálculo de tarifa e comissão (centavos inteiros)
  geo.ts         rotas, geocodificação, área de cobertura
  mapbox.ts      Mapbox: rotas (Directions), endereços (Geocoding), diagnóstico do token
  notify.ts      SSE + notificações persistentes
public/          frontend (mobile-first, 3 apps)
tests/           testes ponta a ponta (node --test)
data/            banco, segredo de sessão e uploads privados (criado em runtime)
```

## Regras de negócio implementadas

- **Tarifas** (configuráveis na central, nunca fixas no código):
  Econômica R$ 5,50 até 2 km + R$ 2,00/km proporcional;
  Prioridade R$ 6,50 até 2 km + R$ 3,00/km proporcional (despacho prioritário:
  os 3 parceiros mais próximos são avisados 8 s antes dos demais).
- **Preço no servidor**: a cotação é persistida por categoria com a tarifa
  vigente, expira (10 min), é de uso único e é reconferida antes de criar a
  corrida. O navegador nunca envia preço. Dinheiro em **centavos inteiros**.
- **Comissão 15/85**: congelada na corrida no momento da solicitação;
  alterações futuras de tarifa/comissão não afetam corridas antigas
  (histórico em `fare_history` + snapshot na corrida).
- **Aceite atômico**: `UPDATE ... WHERE status='requested' AND driver_id IS NULL`
  — só um mototaxista consegue, o segundo recebe 409.
- **Estados**: requested → accepted → in_progress → completed / cancelled,
  com transições validadas no servidor. Desistência do mototaxista antes do
  embarque devolve a corrida à fila e re-despacha automaticamente.
- **Cancelamento**: passageiro (requested/accepted), mototaxista
  (accepted/in_progress), com registro de quem/quando/motivo/estado anterior.
  Corrida concluída é imutável. Cancelada não gera comissão nem ganhos.
- **"Mototaxistas online agora"**: conta apenas aprovados, online, não
  bloqueados, com localização dos últimos 2 min e sem corrida ativa.
- **Área de cobertura**: origem e destino validados no servidor contra o
  centro/raio configuráveis (padrão 12 km de Assis Chateaubriand).
- **Pagamentos**: dinheiro/Pix registrados com estado real
  (pendente/recebido confirmado pelo parceiro) — **nenhum pagamento é
  simulado**; gateway de cartão fica para integração futura (ver abaixo).

## Privacidade e segurança (LGPD)

- Documentos (CNH, CRLV, selfie) ficam em `data/uploads/` **fora da pasta
  pública**, servidos apenas por **links assinados HMAC que expiram em 10 min**
  para administradores.
- Senhas com scrypt; sessões revogáveis; bloqueio derruba a sessão na hora.
- Permissões validadas no backend em toda rota (passageiro × motorista × admin);
  ninguém acessa corrida, chat ou documento de terceiros.
- Localização: pedida com permissão explícita, usada só durante disponibilidade/
  corrida; passageiros veem apenas posições **aproximadas (~110 m)** e anônimas
  dos parceiros livres; o telefone do passageiro não é exposto ao parceiro
  (chat interno na plataforma).
- Ações administrativas registradas em `admin_audit_logs`.
- Rate limiting em login/registro/geocodificação.

## Testes da V2 (executados de verdade)

`npm test` roda **61 testes**. Resultado da última execução:
**61/61 aprovados**. Cobrem, entre outros:

- **Credenciais**: salvas cifradas (o `.db` não revela o segredo), devolvidas
  mascaradas, valor mascarado reenviado não corrompe o que está salvo, URL
  inválida recusada, e só o administrador acessa.
- **Split/OAuth**: link de autorização só é gerado com o app configurado,
  `state` forjado no retorno é recusado (CSRF), e a cobrança após o aceite
  **bloqueia o início da corrida** enquanto o pagamento não confirma.

- **Pagamento**: corrida só é despachada depois da confirmação do provedor; o
  parceiro não vê nem aceita corrida não paga; frontend não consegue marcar
  pagamento como aprovado; estorno no cancelamento; dinheiro vira dívida;
  dívida acima do limite tira o parceiro do ar.
- **Conclusão**: mototaxista declara mas não conclui; passageiro confirma;
  confirmação automática contada **no servidor** (testada com o app fechado);
  confirmar duas vezes não cobra duas vezes (um único lançamento de caixa).
- **Disputa**: congela a corrida, impede a confirmação automática, e a decisão
  da central (concluir/estornar) move o dinheiro corretamente — corrida
  estornada não gera comissão.
- **GPS**: mudança de embarque notifica o parceiro; coordenadas inválidas (0,0 /
  999) recusadas; precisão ruim e localização velha tiram o parceiro da fila.
- **Busca**: prioriza a cidade, ordena por distância, marca fora de área;
  reverse geocode avisa quando o endereço não é exato.
- **Financeiro**: caixa fecha (`comissão + repasse = cobrado`), repasse acima do
  saldo é recusado, livro-caixa sem rota de alteração.
- **Webhook**: evento duplicado é idempotente; assinatura inválida não altera nada.
- **Notificações**: replay por `since`, confirmação de entrega, chave VAPID.
- **Permissões**: parceiro não confirma pela passageira, não mexe em tarifas nem
  no financeiro; passageiro não controla a corrida do parceiro.
- **Mapas (Mapbox)**: com a API do Mapbox simulada no formato real — rota
  define distância e preço e é reaproveitada do cache; busca limitada à área
  atendida, com o que fica fora marcado; endereço do GPS escolhe o item mais
  específico; Mapbox fora do ar ou sem rota cai para a estimativa. Token de
  servidor **não vaza** em nenhuma resposta ao frontend e fica cifrado no
  banco; token secreto (`sk.`) é recusado como token público; "forçar
  OpenStreetMap" ignora o token; só estilos da lista são aceitos; validade e
  limpeza do cache; diagnóstico com e sem token; procedência da rota gravada
  na cotação e na corrida, com o preço batendo com a distância da rota (não a
  linha reta).

### Verificação manual no navegador (V2)

Feita em 375 px (celular) e desktop, com o mototaxista dirigido por script
enquanto o passageiro usava a interface real:

1. Cotação com rota real (5,1 km → R$ 11,66) e as três formas de pagamento.
2. Tela de Pix em modo de teste, com aviso honesto e botão de simulação.
3. Despacho após o pagamento → cartão do parceiro aparecendo **em tempo real**.
4. Modal de confirmação com anel de contagem regressiva do servidor.
5. Confirmação automática funcionando **com o app do passageiro desconectado**
   (`confirmed_by: auto`, pagamento capturado).
6. "Informar um problema" → ocorrência na central → decisão registrada.
7. Financeiro batendo com o banco (R$ 46,64 cobrado / R$ 7,00 comissão /
   R$ 9,91 repasse / R$ 5,25 dívida) e repasse registrado zerando o saldo.
8. Zero erros no console do navegador e no log do servidor.
9. Zero rolagem horizontal: a página do admin saiu de **801 px** (V1) para
   **375 px** num celular de 375 px.

Bugs encontrados *durante* esta verificação e corrigidos: modal de avaliação
abrindo duplicado (SSE + refresh), faixa de menu do admin esticando no celular,
botões saindo da tela em listas, e colunas do grid expandindo em vez de rolar.

## Testes da V1

`npm test` — 15 testes ponta a ponta sobem o servidor real com banco
temporário e cobrem: fórmula de tarifa (exemplos da especificação), divisão
15/85, registro/login/validações, bootstrap e proteção do admin, cotação nas
duas categorias com preço conferido, recusa fora da área de cobertura,
cadastro completo do mototaxista (bloqueio antes da aprovação, documentos
obrigatórios, links assinados válidos/adulterados/sem assinatura, reprovação
exige motivo), fluxo completo da corrida com **aceite simultâneo de dois
motoristas** (um 200, outro 409), chat restrito aos participantes,
cheguei→iniciar→finalizar, comissão e ganhos, avaliação única, cancelamentos
(passageiro, desistência com re-despacho), imutabilidade de tarifas antigas,
bloqueio derrubando sessão, dashboard e suporte.

**Resultado da última execução: 15/15 aprovados.**
A interface foi verificada em navegador real (mobile 375px e desktop):
cadastro, mapa com rota real pelo OSRM em Assis Chateaubriand, cotação
(R$ 7,92 / R$ 10,13 para 3,2 km), solicitação, tela "procurando",
cancelamento, wizard do parceiro, tela de análise com contagem de 48 h,
aprovação pela central e dashboard.

## Dependências externas e pendências legais

| Item | Situação |
|---|---|
| Mapbox | **integrado** (Mapbox GL JS, Directions e Geocoding). Falta você criar a conta em account.mapbox.com, colar o token público na central → 🗺️ Mapas e rodar o "Testar agora" |
| OpenStreetMap/OSRM/Nominatim | reserva automática, pública e gratuita; usada enquanto não houver token do Mapbox |
| Login com Google | opcional; exige `GOOGLE_CLIENT_ID` (gratuito) — instruções no `.env.example` |
| Pix e cartão | **integrado** (Mercado Pago). Falta só você colar as credenciais na central → 💳 Pagamentos; sem elas, modo de teste identificado |
| Split automático | **implementado** (OAuth + `application_fee`). Depende do Client ID/Secret e de cobrar depois do aceite |
| Notificações push | **implementado** (Web Push/VAPID, chaves geradas sozinhas). No iPhone exige o app instalado na Tela de Início — limitação da Apple, diagnosticada na tela |
| Regularização | Lei 12.009/2009 (mototaxista profissional): CNH A com EAR, curso especializado, autorização municipal, colete/capacete padronizados. O envio de documentos no app **não substitui** a autorização legal — configure os requisitos extras na central antes de operar |

## Novidades da V2

Auditoria completa da V1 + correções. O que mudou, em resumo:

| Área | V1 (problema real encontrado) | V2 |
|---|---|---|
| Pagamento | a plataforma não recebia nada: o parceiro pegava o dinheiro e um botão marcava "pago" | cobrança real no provedor **antes** do despacho (Pix/cartão); em dinheiro, a comissão vira **dívida registrada** do parceiro, com bloqueio acima do limite |
| Conclusão | o mototaxista concluía sozinho e marcava o pagamento | ele **declara**; o passageiro confirma em **5 s contados no servidor**, ou confirma automaticamente; capturar o pagamento é consequência disso |
| Disputa | não existia | "Informar um problema" congela a corrida em `disputed`, segura o dinheiro e vai para a central decidir (concluir / estornar / rejeitar) |
| GPS do passageiro | marcador parado: posição lida uma única vez | `watchPosition` contínuo, círculo de precisão, aviso "você mudou de localização" com atualização do embarque (e o parceiro é notificado) |
| Busca de endereços | trazia Cafelândia, Palotina, Formosa do Oeste… sem ordenação | consulta ancorada na cidade, ordenação por distância ao centro, marcação de "fora de área", pontos de referência locais e **seleção tocando no mapa** |
| Notificações | só SSE com a tela aberta | **Web Push real (VAPID)** para app fechado + SSE com reconexão, replay do que se perdeu e confirmação de entrega |
| Painel admin | sem financeiro, tabelas estourando a tela (801 px num celular de 375 px), `prompt()` do navegador | **Financeiro** e **Ocorrências** novos, tabelas viram cartões no celular, zero rolagem horizontal, modais no lugar de `prompt()` |
| Avaliação | só estrelas | estrelas + atendimento, pontualidade, educação e segurança; médias por critério para o parceiro e a central |
| Disponibilidade | contava localização de qualquer precisão | exige precisão mínima, localização recente, sem dívida acima do limite e sem corrida ativa |

Estados da corrida na V2: `pending_payment → requested → accepted → in_progress →
awaiting_confirmation → completed`, com `cancelled` e `disputed`. Todas as
transições são validadas no servidor e gravadas em `ride_events` com autor,
horário e estado anterior.

### Dinheiro: como fica

| Forma | Quem recebe | O que o sistema registra |
|---|---|---|
| Pix / cartão | plataforma | cobrança, comissão e **repasse devido** ao parceiro; o repasse é registrado em `payouts` pela central |
| Dinheiro | o parceiro, na mão | cobrança, comissão e **dívida de comissão** do parceiro; passando do limite ele para de receber corridas até quitar |

O livro-caixa (`financial_transactions`) é **somente inserção** — nada é editado
ou apagado, nem pelo administrador.

### Ativar os pagamentos reais — passo a passo

**Você não precisa editar arquivo nem reiniciar nada.** A central tem a tela
**💳 Pagamentos** com o roteiro completo; as credenciais ficam **cifradas no
banco** (AES-256-GCM) e nunca voltam em texto puro para a tela.

1. **Criar o aplicativo** — entre em
   [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers/panel/app)
   com a conta da empresa → **Criar aplicação** → nome "VAIRO" →
   produto **Pagamentos online** → modelo **Marketplace** (necessário para o split).
2. **Copiar as credenciais de produção** — na aplicação, aba *Credenciais de
   produção*: **Access token** (`APP_USR-…`) e **Public key**.
3. **Publicar o sistema** (Fly.io/Render) e anotar a URL — ex.:
   `https://assis-mototaxi.fly.dev`.
4. **Na central → 💳 Pagamentos**, cole a URL pública e salve. A tela já mostra
   as duas URLs prontas para copiar:
   - webhook: `SUA_URL/api/webhooks/mercadopago`
   - retorno OAuth: `SUA_URL/api/mp/oauth/callback`
5. **No Mercado Pago**, cadastre o webhook (evento **Pagamentos**) e copie a
   **Assinatura secreta**; em *Redirect URIs*, cadastre a URL de retorno.
6. **Cole na central** o Access token, a Public key e a Assinatura secreta →
   **Salvar**.
7. **Passo 3 → Testar agora**: o sistema conversa de verdade com o Mercado Pago
   e lista, item por item, o que está certo e o que falta (inclusive avisa se a
   credencial colada é de teste em vez de produção).

Enquanto o Access token não existir, tudo continua em **modo de teste**
identificado na interface — nada é cobrado nem dado como recebido.

### Split automático: o parceiro recebe direto

Com **Client ID** e **Client Secret** preenchidos (mesma tela, Passo 2), cada
mototaxista vê em *Perfil → Como você recebe* o botão **"Conectar minha conta
Mercado Pago"**. Ele autoriza no site do Mercado Pago (a plataforma nunca vê a
senha dele) e, a partir daí, o dinheiro das corridas cai **direto na conta
dele**, com a comissão retida automaticamente — sem repasse manual.

**O detalhe que exige uma escolha sua:** o Mercado Pago precisa saber *de quem é
a conta que recebe* no momento de criar a cobrança. Por isso o split só funciona
cobrando **depois que um parceiro aceita** a corrida. Na mesma tela você escolhe:

| Modo | Como funciona | Quando usar |
|---|---|---|
| **Antes de chamar** (padrão) | o passageiro paga e só então a corrida vai para os parceiros | dinheiro garantido antes de alguém se deslocar; repasse feito pela central |
| **Depois do aceite** | a corrida sai procurando parceiro; ao aceitar, nasce a cobrança já na conta dele | split automático, sem repasse manual |

No modo "depois do aceite" a corrida **não inicia** enquanto o pagamento não for
confirmado (bloqueio no servidor, com erro explícito para o parceiro). Quem não
conectou a conta continua recebendo por repasse normalmente — os dois modelos
convivem.

### Notificações no iPhone

O iOS só entrega push para sites **instalados na Tela de Início** (iOS 16.4+) —
é limitação da Apple, não do sistema. Em vez de prometer algo que não funciona,
o app faz um diagnóstico do aparelho em *Perfil → Notificações* e mostra:

- no iPhone pelo Safari sem instalar: explica o caminho **Compartilhar →
  "Adicionar à Tela de Início"** e **não oferece** o botão de ativar push (que
  falharia);
- permissão negada antes: ensina a reautorizar nas configurações do site;
- tudo certo: botão **Enviar teste** para o usuário confirmar no próprio aparelho.

Com o app aberto, os avisos chegam por SSE em qualquer aparelho — push é um
reforço, nunca a única via.

### Referência das variáveis (alternativa ao painel)

Sem credenciais o sistema roda em **modo de teste**, claramente identificado na
interface (faixa listrada, QR marcado "MODO-DE-TESTE-SEM-VALOR-REAL" e botão
explícito "simular aprovação"). Nenhum recebimento é simulado em silêncio.

Para operar de verdade, em https://www.mercadopago.com.br/developers:

```bash
MP_ACCESS_TOKEN=APP_USR-...      # credencial de produção
MP_PUBLIC_KEY=APP_USR-...        # necessária para cartão
MP_WEBHOOK_SECRET=...            # "Assinatura secreta" do webhook
PUBLIC_URL=https://seudominio.com.br
```

Cadastre o webhook em `https://seudominio.com.br/api/webhooks/mercadopago`
(evento *Pagamentos*). O sistema valida a assinatura `x-signature`, ignora
eventos repetidos e **nunca** confia no corpo recebido: o status é sempre
reconsultado na API do provedor.

Split automático na conta do parceiro (marketplace via OAuth) está preparado no
código mas **não ativado**: no piloto a plataforma recebe tudo e o repasse é
registrado na central. Isso é uma decisão consciente, documentada aqui.

## Instalação no celular (PWA)

O app é instalável: abre em tela cheia, com ícone próprio, sem passar por
Play Store ou App Store. Requisito: estar publicado em **HTTPS**.

- **Android (Chrome)**: aparece o botão flutuante "📲 Instalar app", ou menu ⋮ →
  "Instalar app".
- **iPhone (Safari)**: Compartilhar → "Adicionar à Tela de Início".

O service worker (`public/sw.js`) guarda só a interface (HTML/CSS/JS, ícones e
tiles do mapa). **API, documentos e eventos em tempo real nunca são cacheados** —
dados sensíveis não ficam no aparelho e o app nunca roda com código velho.
Sem internet, exibe a tela `/offline.html` em vez de erro do navegador.

Para publicar nas lojas de verdade (APK/IPA), o caminho é empacotar o PWA com
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) (Android) ou
Capacitor — fase 2, não é necessário para operar.

### Regerar os ícones

`node tools/make-icons.ts` — redesenha os PNGs a partir do logo vetorial.

## Publicação (produção)

### ⚠️ Por que **não** funciona na Vercel

A Vercel (como Netlify e GitHub Pages) só hospeda **sites estáticos e funções
serverless de vida curta**. Este sistema precisa de três coisas que ela não
oferece:

1. **Processo sempre ligado** — corridas são despachadas por SSE para os
   mototaxistas online. Funções serverless morrem em segundos.
2. **Disco permanente** — o banco SQLite e os documentos (CNH/CRLV) ficam em
   arquivos. Na Vercel o disco é apagado a cada requisição.
3. **Estado compartilhado** — o aceite atômico de corrida depende de um único
   banco com transação. Funções isoladas não garantem isso.

Forçar o projeto na Vercel exigiria trocar SQLite por Postgres externo, os
uploads por armazenamento em nuvem e o SSE por polling — ou seja, reescrever o
backend e pagar mais serviços. **Use as opções abaixo: é mais simples e barato.**

### Opção A — Fly.io (tem plano gratuito, recomendado para começar)

```bash
# instale o CLI: https://fly.io/docs/flyctl/install/
fly auth signup
cd assis-mototaxi
fly launch --no-deploy            # lê o fly.toml já incluso
fly volumes create dados --size 1 # disco permanente do banco e documentos
fly secrets set SESSION_SECRET=$(openssl rand -hex 32) \
                ADMIN_EMAIL=seuemail@gmail.com \
                ADMIN_PASSWORD='uma-senha-forte'
fly deploy
```

Pronto: sai uma URL `https://assis-mototaxi.fly.dev` já com HTTPS (GPS e
instalação no celular funcionando). Região `gru` = São Paulo.

### Opção B — Render (interface gráfica, sem terminal)

1. Suba a pasta para um repositório no GitHub.
2. Em render.com → **New → Blueprint** → aponte para o repositório
   (ele lê o `render.yaml` incluso).
3. Preencha `ADMIN_EMAIL` e `ADMIN_PASSWORD` no painel e confirme.

⚠️ Exige o plano pago mais barato: no gratuito o Render **apaga o disco**, o que
perderia banco e documentos.

### Opção C — VPS próprio (mais controle, ~R$ 25/mês)

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt install -y nodejs
scp -r assis-mototaxi root@SEU_IP:/opt/            # do seu PC
cd /opt/assis-mototaxi && cp .env.example .env && nano .env
```

Serviço + HTTPS automático:

```bash
systemctl enable --now assis     # unit systemd apontando para: node server/index.ts
apt install -y caddy             # Caddyfile: seudominio.com.br { reverse_proxy localhost:8780 }
```

### Domínio próprio

Registre em **registro.br** (~R$ 40/ano) e aponte um registro **A** para o IP
(VPS) ou siga `fly certs add seudominio.com.br` / painel do Render.
HTTPS é **obrigatório** — sem ele o navegador bloqueia o GPS no celular.

### Checklist pós-publicação

1. Entre em `/admin` com o `ADMIN_EMAIL`/`ADMIN_PASSWORD` definidos.
2. Ajuste tarifas, comissão, centro e raio de cobertura em **Configurações**.
3. Abra o site no celular e instale o app (botão 📲).
4. Configure backup do diretório `data/` (`fly ssh console` + `tar`, snapshot do
   disco no Render, ou `cron` no VPS).
