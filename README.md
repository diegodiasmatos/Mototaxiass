
# 🏍️ Assis MotoTáxi

Plataforma completa de transporte de passageiros por motocicleta para
**Assis Chateaubriand – PR**: aplicativo do passageiro, painel do mototaxista
e central administrativa, com mapas reais, GPS em tempo real, tarifas
calculadas no servidor e comissão automática de 15%.

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
| Passageiro | http://localhost:8780/ |
| Mototaxista | http://localhost:8780/motorista |
| Central administrativa | http://localhost:8780/admin |

Para testar no celular, use o IP da máquina na mesma rede Wi-Fi
(ex.: `http://192.168.0.10:8780`).
⚠️ O GPS do navegador (geolocalização) só funciona em `localhost` **ou HTTPS** —
em produção coloque o app atrás de HTTPS (ver "Publicação").

### Primeiro administrador

- Se `ADMIN_EMAIL`/`ADMIN_PASSWORD` estiverem no `.env`, o admin é criado com eles.
- Caso contrário, na primeira execução é criado `admin@assismototaxi.local`
  com **senha aleatória impressa uma única vez no console** — anote-a.
- Não existe cadastro público de administrador.

## Arquitetura

| Camada | Tecnologia | Por quê |
|---|---|---|
| Backend | Node 24 + TypeScript nativo (sem build) | simples, estável, sem toolchain |
| Banco | SQLite (`node:sqlite`) com migrações versionadas | persistente, zero instalação, WAL |
| Tempo real | Server-Sent Events (SSE) | ofertas de corrida, GPS e notificações ao vivo |
| Mapas | Leaflet + OpenStreetMap | sem chave de API e sem cartão de crédito |
| Rotas/ETA | OSRM público (fallback: haversine ×1,3) | distância pela malha viária real |
| Geocodificação | Nominatim restrito à região da cidade | busca de endereços em pt-BR |
| Senhas | scrypt + salt (node:crypto) | hash forte, sem texto puro |
| Sessões | cookie HttpOnly + tabela `sessions` | revogável no servidor (bloqueio derruba sessão) |

> **Google Maps Platform** pode substituir OSM/OSRM/Nominatim no futuro: basta
> trocar as funções em `server/geo.ts` (route/searchAddress/reverseGeocode) —
> o resto do sistema não conhece o provedor. Exige chave com billing no
> console.cloud.google.com (Maps JavaScript API, Places, Routes).

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

## Testes (executados de verdade)

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
| OpenStreetMap/OSRM/Nominatim | públicos e gratuitos; para alto volume, hospede o seu ou migre para Google Maps (chave + billing) |
| Login com Google | opcional; exige `GOOGLE_CLIENT_ID` (gratuito) — instruções no `.env.example` |
| Gateway de cartão/Pix automático | **não integrado** (nada é simulado); sugerido: Mercado Pago/Pagar.me + webhooks |
| Notificações push em segundo plano | navegador só notifica com o site aberto; app nativo/PWA+FCM fica para fase 2 |
| Regularização | Lei 12.009/2009 (mototaxista profissional): CNH A com EAR, curso especializado, autorização municipal, colete/capacete padronizados. O envio de documentos no app **não substitui** a autorização legal — configure os requisitos extras na central antes de operar |

## Publicação (produção)

1. Servidor Linux ou Windows com Node 24+; copie a pasta, crie `.env` com
   `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` fortes.
2. Rode como serviço (systemd/NSSM/PM2: `pm2 start server/index.ts --interpreter node`).
3. Coloque atrás de HTTPS (Caddy ou nginx + certbot) — obrigatório para o GPS
   e para proteger as sessões. Ex.: Caddy: `seudominio.com.br { reverse_proxy localhost:8780 }`.
4. Faça backup periódico da pasta `data/` (banco + documentos).
5. Acesse `/admin`, troque a senha, ajuste tarifas, comissão e raio de cobertura.
# Mototaxiass
