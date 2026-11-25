# VAIRO na Google Play — o que está pronto e o que falta

O app Android é o próprio app web da VAIRO empacotado como **Trusted Web Activity
(TWA)**, o formato oficial do Google para publicar um app web na Play Store
(ferramenta [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)). As
atualizações do site chegam ao app sozinhas; um novo `.aab` só é necessário
para mudar ícone, nome, permissões ou a versão do Android exigida pela Play.

## Arquivo gerado

| Arquivo | Para quê |
|---|---|
| `vairo-1.0.0-versao1.aab` | Enviar à Play Console (assinado com a chave de envio) |
| `vairo-1.0.0-teste.apk` | Instalar direto num Android para testar antes de enviar |

Conferido no próprio arquivo (`aapt2`, `apksigner`, `jarsigner`):

- pacote **`br.com.vairo.app`** (permanente depois do primeiro envio);
- versão **1.0.0**, código de versão **1**;
- **targetSdk 36** (Android 16), exigido para apps novos desde 31/08/2026;
  minSdk 24 (Android 7.0, mínimo da biblioteca oficial de TWA);
- permissões: `POST_NOTIFICATIONS`, `ACCESS_FINE_LOCATION`,
  `ACCESS_COARSE_LOCATION` (só com o app aberto; **sem** localização em
  segundo plano, **sem** câmera, **sem** ID de publicidade);
- assinatura: chave de envio `upload`, SHA-256
  `AD:30:27:2C:95:A0:77:8E:29:ED:8A:27:C5:B7:8B:29:A1:61:4B:36:0D:A4:62:28:88:BC:78:5D:71:B6:96:A2`.

A **chave de envio** (`upload-key.jks`) e a senha foram entregues
separadamente e **não estão no repositório**. Guarde as duas em dois lugares
seguros. Com o *Play App Signing* (padrão para apps novos), se a chave de envio
se perder dá para pedir a troca ao Google.

## O que o app/site já faz para a Play

- `/.well-known/assetlinks.json` liga o app ao site (impressão digital da chave
  de envio no `fly.toml`; a do Google entra pela central depois do 1º envio);
- Política de Privacidade em **https://assis-mototaxi.fly.dev/privacidade**
  (ainda **preliminar** — ver pendências);
- exclusão de conta **no app** (Perfil → Conta e privacidade) e **na web**, sem
  login: **https://assis-mototaxi.fly.dev/excluir-conta**;
- Termos de Uso aprovados exibidos **sem alteração** em `/termos`
  (arquivo `public/legal/termos-de-uso.md`, protegido por teste);
- regras de cancelamento e cobrança na tela de preço, **antes** de pedir;
- no app instalado não aparecem o menu de telas do protótipo nem o botão
  "Instalar app".

## Passo a passo (só o responsável pela conta pode fazer)

1. **Conta de desenvolvedor pessoal** em https://play.google.com/console
   (taxa única de US$ 25 e verificação de identidade com documento).
2. **Antes de publicar**, completar os textos legais (ver "Pendências") e
   publicar o site com esta versão (assetlinks, `/excluir-conta`, Termos).
3. Criar o app: nome, idioma pt-BR, "App", "Gratuito".
4. **Conteúdo do app** (menu lateral): preencher com base em
   [`CONTEUDO-DO-APP.md`](CONTEUDO-DO-APP.md) — política de privacidade,
   acesso ao app (contas de teste), anúncios, classificação, público-alvo,
   Segurança dos dados ([`SEGURANCA-DOS-DADOS.md`](SEGURANCA-DOS-DADOS.md)).
5. **Página da loja**: textos de [`LISTAGEM.md`](LISTAGEM.md), ícone
   `android/store_icon.png` (512×512), banner `imagens/banner-destaque-1024x500.jpg`
   e as capturas `imagens/1…8-*.png` (1080×1920).
6. **Teste fechado obrigatório** (contas pessoais criadas depois de
   13/11/2023): enviar o `.aab` numa faixa de teste fechado com **pelo menos 12
   testadores** que fiquem inscritos **14 dias seguidos**; só então pedir
   acesso à produção (análise de cerca de 7 dias).
7. Depois do primeiro envio: Play Console → *Integridade do app → Assinatura
   de apps* → copiar a **impressão digital SHA-256 da chave de assinatura do
   app** e colar na central (Configurações → App Android). Sem isso o app abre
   com a barra de endereço do navegador.
8. Testar o app baixado da Play (login, pedir corrida, embarque, notificações,
   localização) e só então liberar em produção.

## Próximas versões

Mude `appVersionCode`/`appVersion` em `android/twa-manifest.json` e
`versionCode`/`versionName` em `android/app/build.gradle` (o código sempre
maior que o anterior) e rode `android/gerar-aab.sh` com a chave.

## Pendências que só você pode resolver

- **Termos de Uso**: completados a pedido dos responsáveis (2 pessoas físicas,
  modelo "prestadora do transporte", regras reais do app). O texto aprovado
  original está em `docs/legal/termos-de-uso-aprovado-original.md` para o
  advogado validar as mudanças.
- **Termos de cookies**: o texto recebido é o dos Termos de Uso. Não há no
  projeto um texto de cookies aprovado. Os cookies usados (só o de sessão e a
  preferência de tema) estão descritos na Política de Privacidade preliminar.
- **Política de Privacidade**: completa (controladores, bases legais, prazos
  de guarda de 180 dias para GPS e chat, direitos), mas ainda **sem validação
  de advogado**; a página mostra esse aviso até a central marcar como revisada.
- **Contas de teste para a análise do Google** (Acesso ao app): criar no app
  publicado um passageiro e um motorista aprovado só para isso, e informar
  e-mail/senha na Play Console. A área de atendimento é Assis Chateaubriand;
  explique isso nas instruções para o revisor.
- **Público-alvo**, **classificação indicativa** e **Segurança dos dados**:
  rascunhos prontos, mas as respostas são declarações suas — confira cada uma.
