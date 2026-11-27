# VAIRO — Auditoria de prontidão para lançamento (27/11/2026)

Escopo: código (`server/`, `public/`, `tests/`), banco (migrações v1–v12),
infraestrutura (Fly.io, `fly.toml`, CI), site publicado
(https://assis-mototaxi.fly.dev, **só leitura**) e testes controlados num
servidor local idêntico ao publicado. Nada foi testado de forma destrutiva em
produção; nenhum dado de usuário real foi acessado.

Legenda: **[E]** evidência (medido/visto), **[S]** suspeita (não confirmada),
**[R]** recomendação.

---

## 1. Diagnóstico geral

O núcleo de mobilidade funciona de ponta a ponta e é tecnicamente sólido para o
porte de Assis Chateaubriand: pedido com preço antes, despacho, aceite sem
corrida duplicada, código de embarque, acompanhamento ao vivo, cancelamento,
pagamento (Mercado Pago ativo em produção) e notificações. Há 144 testes
automáticos que barram a publicação se falharem.

Os bloqueios para abrir ao público **não estão no fluxo da corrida**. Estão em:

- segurança operacional: repositório público, com histórico que contém o banco
  antigo e a chave de sessão;
- base de mototaxistas: **0 online** na produção no momento da auditoria;
- validação jurídica e municipal ainda pendente;
- infraestrutura de uma máquina só, sem monitor externo nem cópia fora do servidor.

Uma vulnerabilidade de queda do servidor foi encontrada e **corrigida** nesta
etapa (seção 5).

## 2. Notas por categoria (0–10)

| Categoria | Nota | Evidência |
|---|---|---|
| Tecnologia | 7 | Node/TS sem dependências, migrações versionadas com cópia antes, 144 testes no CI. Arquivos grandes (common.js 1,5 mil linhas) e servidor/banco numa máquina só. |
| Segurança | 6 | scrypt, sessões HttpOnly/Secure/SameSite, limite de tentativas pelo IP real, documentos por link assinado, HSTS e X-Frame. Contra: repositório público com segredo no histórico [E], queda por requisição grande [E, corrigida], CSP só em modo "avisa", central sem 2º fator. |
| Design | 6 | Identidade consistente (claro/escuro, ícones, tipografia). Seletor de telas de protótipo visível ao usuário [E], endereço como coordenadas em ruas sem nome [E], botão "Instalar" cobrindo conteúdo [E, corrigido]. |
| Experiência do passageiro | 7 | Fluxo completo testado com 2 contas. "Esqueci a senha" depende da central pelo WhatsApp; sem verificação de telefone. |
| Experiência do motorista | 6 | Fluxo completo testado. GPS para com a tela apagada (limite do navegador); repasse manual; não testado em aparelho real. |
| Mapas | 7 | Rota real por ruas (Mapbox em produção, OSRM de reserva), busca com base IBGE (número exato), consentimento, privacidade, tetos de custo. Mapbox usa perfil de carro (não há de moto); OSM com ruas sem nome. |
| Notificações | 7 | Central, preferências, push sem dados sensíveis e eventos reais testados. Entrega do push num celular real **não testada**. |
| Desempenho | 8 | 100 passageiros + 50 mototaxistas simultâneos: 0 erros, p95 < 0,7 s, 148 MB [E, local]. Tela de entrada de 2,3 MB → 424 KB [E, corrigido]. |
| Infraestrutura | 5 | 1 máquina (shared-cpu-1x, 512 MB), reinício automático, health check. Sem monitor externo, cópias só no mesmo disco, logs só no painel da Fly. |
| Preparação comercial | 3 | Termos e Privacidade publicados, mas com aviso "aguarda advogado" [E]. Sem CNPJ, autorização municipal não verificada, Empresa inexistente [E], nenhum mototaxista online [E]. |

## 3. Problemas encontrados

### P0 — crítico

| # | Problema [tipo] | Onde | Impacto | Solução | Dificuldade | Teste |
|---|---|---|---|---|---|---|
| P0-1 | Requisições de até 30 MB aceitas **sem login**: 8 delas levam o servidor a 578 MB (a máquina tem 512 MB) e o app cai [E] | `server/util.ts` (readBody) | Qualquer pessoa derruba o app | Limite de 512 KB por padrão, maiores só em rotas com login, recusa pelo tamanho declarado, 1 envio grande por vez | Baixa | **Corrigido.** 40×29 MB → recusadas, 122 MB; 10×33 MB com login → pico 336 MB; teste automático |
| P0-2 | Repositório GitHub **público** [E]; o histórico tem `data/assis.db`, `data/.secret` e documentos de teste [E] | GitHub | Se a produção usar a mesma chave: sessões forjáveis e credenciais (Mercado Pago, Mapbox) decifráveis [S] | (1) Tornar privado. (2) Comparar a impressão digital da chave (seção 8). (3) Se for igual: trocar a chave e recadastrar as credenciais | Baixa (você) | Impressão digital diferente, ou troca feita |
| P0-3 | Operação comercial sem verificação jurídica: textos com aviso de rascunho [E], sem CNPJ, autorização municipal de mototáxi não confirmada | Termos/Privacidade; fora do código | Risco legal e de responsabilização pessoal (CPF dos responsáveis publicado) | Advogado + Prefeitura + contador (seção 9) | Externa | Documentos |

### P1 — alto (antes do público)

| # | Problema [tipo] | Onde | Impacto | Solução | Dificuldade | Teste |
|---|---|---|---|---|---|---|
| P1-1 | Sem proteção de origem nas ações (só SameSite) [E] | `server/index.ts` | CSRF em navegadores antigos | Ação vinda de outro site é recusada | Baixa | **Corrigido**; teste automático (webhook segue funcionando) |
| P1-2 | Documento aceito só pelo tipo declarado [E] | `server/drivers.ts` | Arquivo disfarçado chega à central | Confere a assinatura real (JPEG/PNG/WebP/PDF); ao abrir: sandbox + nosniff | Baixa | **Corrigido**; teste com HTML disfarçado → 400 |
| P1-3 | Mapbox (provedor ativo) sem teto de consumo [E] | `server/mapbox.ts` | Conta inesperada num pico | Teto mensal (mapa 45 mil, rotas 50 mil, endereços 50 mil), painel na central | Baixa | **Corrigido**; teste automático |
| P1-4 | Tela de entrada baixa 2,3 MB (biblioteca do mapa) [E] | passenger.js/driver.js | Lento em 4G | Mapa carregado só depois do login | Baixa | **Corrigido**: 424 KB |
| P1-5 | Botão "Instalar app" flutuante cobre "Esqueci minha senha" e o botão principal [E] | common.js | Toque errado | Virou ícone no cabeçalho | Baixa | **Corrigido**; captura de tela |
| P1-6 | Início só com 3 botões; "Empresa" leva a "Em breve" [E] | visao-geral.html | Visitante não entende o serviço | "Como funciona", área, preço real do servidor, atendimento, links legais; "Empresa · em breve" | Baixa | **Corrigido**; captura de tela |
| P1-7 | Seletor "Tela 1 de 6 · 1. Login" (navegação de protótipo) visível a todos no navegador [E] | `setupScreenMenu` | Parece protótipo; leva a telas sem contexto | Esconder para usuários (mostrar só com `?telas=1` ou para a central) | Baixa | **Decisão sua**: foi um recurso pedido antes, não removi |
| P1-8 | Nenhum monitor externo; cópias só no mesmo disco [E/S] | Infra | Queda sem aviso; perda do disco = perda de tudo | UptimeRobot em `/api/health`; baixar a cópia diária; confirmar snapshots do volume | Baixa (você) | Alerta recebido; arquivo de cópia |
| P1-9 | Push não testado em celular real; GPS para com a tela apagada (limite do navegador) [E] | Android/iOS | Mototaxista perde corrida com a tela apagada | Teste piloto com aparelhos reais; orientar a manter a tela ligada | Média | Cenários 2, 8 e 9 do piloto |
| P1-10 | "Esqueci minha senha" depende da central pelo WhatsApp [E] | account.ts | Atendimento manual | Serviço de e-mail transacional | Média (precisa de conta) | Fluxo de redefinição |

### P2 — médio

- **P2-1** CSP completa ainda em modo "só avisa" [E]: ligar `CSP_ENFORCE=1` depois de verificar o console com o Mapbox.
- **P2-2** Central sem 2º fator de login [E]: 2FA por aplicativo autenticador.
- **P2-3** Endereço "Ponto no mapa (coordenadas)" quando a rua não tem nome no OSM [E]: em produção a base do IBGE dá "Perto de …"; recomendado mostrar o bairro.
- **P2-4** Mapbox calcula rota de **carro** [E]; a de moto só existe no Google (SKU Enterprise, 1.000 grátis por mês, já com teto).
- **P2-5** Leaflet com linhas finas entre os blocos do mapa em telas com escala fracionária [E, visual]; só no mapa de reserva.
- **P2-6** Erros 401 no console ao abrir as telas sem login [E, cosmético].
- **P2-7** Uma máquina só: publicar tira o app do ar por alguns segundos [E].

### P3 — futuro

Verificação de telefone (SMS), avaliação do passageiro e regra de não
comparecimento, cupons, recibo em PDF, perfil Empresa (não existe), app nativo
para GPS em segundo plano, segunda região.

## 4. Funcionalidades: o que existe de verdade

| Item | Situação | Prioridade |
|---|---|---|
| Chat passageiro ↔ mototaxista | Existe | — |
| Botão de emergência (190) e compartilhar corrida (dados) | Existe; o compartilhamento não é rastreio ao vivo | P2 (link de rastreio) |
| Suporte e ocorrências | Existe (chat com a central, "Não embarquei") | — |
| Avaliação do mototaxista | Existe; **do passageiro, não** | P2 |
| Histórico, favoritos, destinos recentes | Existe | — |
| Política de cancelamento | Na tela de cotação | — |
| Painel administrativo e relatórios | Existe (dashboard, financeiro, auditoria) | — |
| Pagamentos | Pix, cartão (Mercado Pago) e dinheiro | — |
| Comprovante de corrida | Só no histórico (sem PDF) | P2 |
| Cupons | Não existe | P3 |
| Termos e Privacidade | Publicados, com aviso de rascunho | **P0-3** |
| Perfil Empresa | **Não existe** ("Em breve") | P3 |

## 5. Melhorias implementadas nesta etapa

Branch `claude/prontidao-lancamento` (ainda **não** publicado):

1. Limite de tamanho por rota e fila de envios grandes (P0-1).
2. Recusa de ações vindas de outros sites (P1-1).
3. Assinatura real dos documentos; sandbox ao abrir (P1-2).
4. Teto de consumo do Mapbox, painel "Google e Mapbox" (P1-3).
5. Mapa carregado só depois do login (P1-4).
6. Botão de instalar no cabeçalho (P1-5).
7. Página inicial com "como funciona", área, preço real, atendimento e links legais; "Empresa · em breve" (P1-6).
8. Testes novos: corpo grande, origem, documento disfarçado, teto do Mapbox.

## 6. Testes realizados (resultados reais)

- **Automáticos**: 144 de 144 passam (`npm test`).
- **Carga (local, máquina mais rápida que a da produção)**:

  | Simultâneos | Erros | Busca p95 | Cotação p95 | Pedido p95 | GPS p95 | Memória |
  |---|---|---|---|---|---|---|
  | 10 passageiros + 5 mototaxistas | 0 | 21 ms | 81 ms | 57 ms | 91 ms | 138 MB |
  | 50 + 25 | 0 | 185 ms | 344 ms | 52 ms | 228 ms | 145 MB |
  | 100 + 50 | 0 | 432 ms | 525 ms | 162 ms | 495 ms | 148 MB |

  Disputa: 50 mototaxistas aceitando a mesma corrida → 1 aceito, 49 recusados.
  Na máquina da produção (CPU compartilhada) os tempos devem ser maiores; a
  memória é o limite real e sobra folga.
- **Ponta a ponta (navegador, Pixel 7 simulado, 2 contas, rota real OSRM)**:
  consentimento; GPS; busca; ajuste no mapa; rota; pedido; aceite; aproximação
  ao vivo + aviso; mototaxista vendo o passageiro; cancelamento encerrando o
  compartilhamento; offline parando o GPS; terceiro bloqueado (403); telas de
  360 px e computador sem rolagem lateral; 0 erros de JavaScript.
- **Não testado**: celular Android/iPhone real, entrega do push no aparelho,
  pagamento real com Mercado Pago, perda de internet e GPS desligado em
  aparelho real (cenários 8 e 9: só os testes automáticos de reconexão).

## 7. Custos (mensais)

| Item | Valor | Tipo |
|---|---|---|
| Fly.io: 1 máquina shared-cpu-1x 512 MB + disco 1 GB | ~US$ 3–5 | Estimativa (confira fly.io/docs/about/pricing) |
| Mapbox: mapa | grátis até 50.000 carregamentos | Confirmado (mapbox.com/pricing); teto no app: 45.000 |
| Mapbox: rotas e endereços | grátis declarado por terceiros (100.000) | **Não confirmado**; teto no app: 50.000 |
| Google Maps | não configurado (R$ 0) | Confirmado em produção |
| Mercado Pago | taxa por transação | Confira no painel do Mercado Pago |
| Domínio .com.br | ~R$ 40/ano | Estimativa |
| E-mail transacional e SMS | só se forem contratados | — |

Para 100 usuários simultâneos a máquina atual basta (seção 6). Folga extra:
shared-cpu-2x com 1 GB, cerca de US$ 10–12 por mês (estimativa).

## 8. Pendências que dependem de você

1. **Hoje**: GitHub → Settings → Change visibility → **Private**.
2. **Chave de sessão**: rode o comando abaixo e compare com `413e68a50911716e`, a impressão digital da chave que está no histórico público.

   ```
   fly ssh console -a assis-mototaxi -C "sha256sum /data/.secret"
   ```

   Se os 16 primeiros caracteres forem iguais, me avise **antes** de trocar: a chave também cifra o Mercado Pago e o Mapbox gravados na central.
3. UptimeRobot (grátis) em `https://assis-mototaxi.fly.dev/api/health`, com alerta no seu e-mail ou WhatsApp.
4. Baixar a cópia diária do banco na central toda semana; conferir os snapshots do volume `dados` no painel da Fly.
5. Advogado: Termos, Privacidade, responsabilidades e prazo de exclusão.
6. Prefeitura de Assis Chateaubriand: existe lei de mototáxi? Exige alvará ou licença por mototaxista e moto? A intermediação por aplicativo é permitida?
7. Contador: CNPJ (o recebimento de comissão por pessoa física é um risco), ISS municipal sobre intermediação, emissão de nota.
8. Recrutar e aprovar os primeiros mototaxistas (requisitos da Lei 12.009/2009: 21 anos, 2 anos de CNH categoria A, curso especializado e colete).
9. Decidir sobre o seletor de telas de protótipo (P1-7).
10. Teste piloto com aparelhos reais (seção 9).

## 9. Plano de lançamento

**Etapa 0 (semana 1): bloqueios**
- repositório privado e checagem da chave;
- publicar este branch;
- monitor externo;
- advogado, Prefeitura e contador iniciados.

**Etapa 1 (semanas 2–3): teste fechado, 3–5 mototaxistas e 10–20 passageiros conhecidos**
- roteiro dos 10 cenários:
  1. cadastro e pedido;
  2. aceite e encontro;
  3. acompanhamento no mapa;
  4. início e fim da corrida;
  5. histórico;
  6. avaliação;
  7. cancelamento com aviso aos dois;
  8. internet caindo durante a corrida;
  9. GPS desligado;
  10. pedidos simultâneos.
- cada resultado registrado numa planilha: cenário, aparelho, resultado e erro.
- critério para avançar: zero falha de pagamento ou corrida e push confirmado em Android.

**Etapa 2 (semanas 4–6): piloto em Assis**
- só depois dos documentos jurídicos e municipais;
- divulgação boca a boca, horário reduzido e acompanhamento diário da central.

**Etapa 3 (mês 2 em diante): divulgação e expansão**
- redes sociais e material;
- Google Play (o pacote .aab já foi gerado);
- só com indicadores estáveis: taxa de aceite, tempo até o aceite, cancelamentos e reclamações.

## 10. Veredito

**PRONTO PARA TESTE INTERNO** hoje.

O produto funciona e aguentou 100 usuários simultâneos no teste local. Ainda não pode receber o público por três motivos:

- o repositório público com o segredo no histórico;
- a ausência de validação jurídica e municipal;
- nenhum mototaxista disponível.

Passa a **PRONTO PARA TESTE PILOTO** quando:

1. este branch for publicado;
2. o repositório estiver privado e a chave checada;
3. o teste fechado com aparelhos reais passar.

Lançamento público só depois do aval jurídico e municipal.
