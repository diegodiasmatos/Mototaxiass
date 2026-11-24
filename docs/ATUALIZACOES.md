# Atualizações do app para quem já tem instalado

O VAIRO é um **PWA** (aplicativo web instalado pela tela inicial do celular).
Não existe versão na Play Store nem na App Store. Por isso, publicar uma versão
nova é só publicar o servidor. Não há loja, revisão de loja nem build nativo.

## Como funciona

1. Ao ligar, o servidor calcula a **versão do app**: um resumo (hash) de todos
   os arquivos de `public/` (`server/version.ts`). Mudou qualquer arquivo,
   muda a versão. Ninguém precisa trocar número à mão.
2. Essa versão vai para três lugares:
   - `GET /api/version` (sem login, sem cache);
   - dentro do `/sw.js` (linha `const VERSION`);
   - em cada página, na `<meta name="app-version">`.
3. O navegador do celular confere o `/sw.js` ao abrir o app. O app também pede
   essa conferência ao voltar para a tela, ao reconectar e a cada 10 minutos.
   Se o arquivo mudou, o service worker novo é instalado, guarda os arquivos
   novos e apaga o cache da versão antiga.
4. A página aberta compara a própria versão com `/api/version`:
   - **sem nada em andamento**, o app recarrega sozinho quando está em segundo
     plano ou ao voltar para a tela;
   - **com algo em andamento**, aparece o aviso **"Nova versão disponível ·
     Atualizar"** e nada recarrega sozinho. Conta como "em andamento": corrida
     ativa, motorista online, janela aberta, ou texto que a pessoa digitou.
5. Se a página recarregou e ainda veio a versão antiga (por exemplo, sem
   internet no meio), ela não tenta de novo sozinha. Só mostra o aviso.

## O que é preservado

| Dado | Onde fica | Afetado pela atualização? |
|---|---|---|
| Login | cookie `amt_session` | Não. O cache é de arquivos, não de cookies |
| Tema claro/escuro | `localStorage` (`vairo-theme`) | Não |
| Favoritos, corridas, carteira, perfil | banco do servidor | Não |
| Notificações (push) | assinatura no navegador | Não. O service worker é atualizado no mesmo endereço `/sw.js`, então a assinatura continua valendo |
| Blocos do mapa e imagens já baixados | cache `amt-media` | Mantidos entre versões, com limite de 600 itens |

Nenhuma atualização apaga dado do banco. Mudanças no banco continuam passando
pelas migrações de `server/db.ts`, com cópia de segurança antes.

## O que atualiza sozinho e o que não atualiza

| O quê | Atualiza sozinho? |
|---|---|
| Telas, textos, regras no navegador, CSS, JS | **Sim**, na próxima abertura ou volta para o app |
| Regras do servidor (preços, despacho, API) | **Sim**, na hora do deploy. Não depende do celular |
| Logo e imagens dentro do app | **Sim**. Imagem própria é conferida em segundo plano e aparece na abertura seguinte |
| Ícone e nome na tela inicial, **Android** (Chrome) | Sim, mas **quem decide é o Chrome**. Ele confere o manifesto de tempos em tempos, normalmente em alguns dias |
| Ícone e nome na tela inicial, **iPhone** | **Não**. O iOS guarda o ícone de quando o app foi adicionado. Para ver o ícone novo, é preciso remover o atalho e adicionar de novo pelo Safari |
| App aberto em uma corrida | Não recarrega sozinho. Mostra o aviso e espera |

## Como publicar uma atualização

1. Faça a mudança em um branch e abra um pull request. Rode `npm test` antes.
2. **Juntar (merge) no `main` publica**: o workflow `.github/workflows/fly.yml`
   roda os testes de novo e faz o deploy no Fly.io.
3. Pronto. Os celulares recebem a versão nova sozinhos, como descrito acima.

Para conferir: abra `https://<seu-app>/api/version` antes e depois do deploy.
O valor muda. Na central, em **Configurações**, aparece a versão do app aberto.

Não é preciso nenhum serviço extra (nem Firebase, nem loja, nem CodePush).
Custo: nenhum além da hospedagem que já existe.

> **Atenção, hospedagem.** O teste gratuito da Fly.io terminou. Enquanto não
> houver cartão cadastrado em https://fly.io/trial, o deploy falha e o app fica
> fora do ar. Isso não tem relação com o mecanismo de atualização.

## Primeira vez (quem está com a versão antiga instalada)

Quem tem a versão anterior a este mecanismo também recebe esta: o `/sw.js` muda
(a linha `VERSION`), o navegador instala o service worker novo, e o HTML/JS já
era buscado "rede primeiro". Na próxima abertura do app com internet, a pessoa
já está na versão nova, e daí em diante vale o aviso/recarregamento automático.

## Verificação feita

- `tests/update.test.ts`: a versão aparece igual em `/api/version`, no `sw.js`
  e nas páginas; muda quando um arquivo muda; não precisa de login.
- No Chromium (Playwright), com um servidor local:
  1. passageiro logado na versão A;
  2. servidor reiniciado com a versão B;
  3. com texto digitado no destino, só apareceu o aviso, e o texto continuou lá;
  4. sem texto, ao voltar para a tela, o app recarregou sozinho na versão B,
     continuou logado, manteve o tema e apagou o cache da versão A.

Não foi testado em iPhone ou Android de verdade (só no Chromium). O
comportamento do ícone na tela inicial (tabela acima) vem da documentação dos
navegadores, não de teste.
