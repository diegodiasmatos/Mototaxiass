# Antes do lançamento — o que foi feito e o que falta

Este arquivo acompanha a auditoria de lançamento. Para cada item: o que o
código já resolve e o que depende de uma ação sua (configuração, serviço
externo, advogado ou teste em celular de verdade).

## ⚠️ Antes de atualizar uma cópia local do projeto (`git pull`)

A pasta `data/` (banco, chave `.secret` e documentos) **deixou de ser
versionada**. Quem já tem o projeto baixado e fizer `git pull` terá essa pasta
**apagada do computador** pelo Git. Antes de atualizar, copie a pasta `data/`
para outro lugar e devolva depois. O servidor publicado (Fly.io) não é
afetado: ele usa o disco próprio `/data`.

## Críticos

| Item | O que o código faz agora | O que falta (você) |
|---|---|---|
| C1 · dados no repositório | `data/` fora do Git e no `.gitignore` | 1) Tornar o repositório **privado** (GitHub → Settings → General → Danger Zone → Change visibility). 2) Os arquivos continuam no **histórico** antigo: apagar de lá reescreve o histórico e exige `git push --force` (irreversível, por isso não foi feito). 3) Avisar o dono da conta `@gmail.com` que estava no banco. 4) Conferir se a produção usa a mesma chave `.secret`; se usar, trocar `SESSION_SECRET` (todos precisam entrar de novo). |
| C2 · passageiro preso | Cancela com Pix pendente; Pix vencido (+5 min) e corrida sem aceite (15 min, ajustável; 0 desliga) são cancelados com estorno | Nada. Ajuste o prazo em Configurações se quiser. |
| C3 · limite de tentativas | IP real via `Fly-Client-IP` (`TRUST_PROXY=1` no `fly.toml`); só senha errada conta (20 por IP, 8 por conta, 15 min) | Nada. |
| C4 · pagamento de teste no ar | `APP_ENV=production` no `fly.toml`: sem Mercado Pago, **só dinheiro** | Configurar o Mercado Pago na central (💳 Pagamentos) para liberar Pix e cartão. |
| C5 · termos e privacidade | Páginas `/termos` e `/privacidade` (preliminares), aceite obrigatório com versão e data, janela de aceite para contas antigas | 1) Preencher razão social, CNPJ, endereço, contato e encarregado em Configurações. 2) **Revisão por advogado** dos textos e dos pontos marcados em amarelo. 3) Depois, marcar "revisados por um advogado" (tira o aviso). |
| C6 · senha | Troca de senha no perfil; "Esqueci minha senha" avisa a central, que gera link de uso único (60 min) para enviar pelo WhatsApp | Automatizar por e-mail ou SMS exige um serviço de envio (ex.: e-mail transacional ou SMS) e credenciais. |
| C7 · exclusão de conta | Pedido no perfil (com senha); a central anonimiza em 🔒 Privacidade | Definir com o advogado o prazo para atender o pedido e o que deve ser guardado por obrigação legal. |

## Importantes

| Item | Feito | Falta |
|---|---|---|
| I1 · funções anunciadas | Menu sem "Vitrine", "Cardápio", "SOS"; "Mapa de Calor" virou "Ficar online"; menu da Empresa escondido | — |
| I2 · segurança na corrida | Botão Emergência (190) e "Compartilhar corrida" (dados, não localização ao vivo) | Acompanhamento ao vivo por link exigiria uma página pública de rastreio (não feito). |
| I3 · requisitos do mototaxista | Validade da CNH, 1ª habilitação, declaração de categoria A com EAR e de curso; idade mínima 21 e 2 anos de CNH (ajustáveis); conferência na aprovação | **Confirmar com advogado e com a prefeitura** os requisitos (Lei 12.009/2009, normas do CONTRAN e lei municipal) e se há licença municipal. A conferência dos documentos continua manual. |
| I4 · tela apagada | Pede para manter a tela ligada (Wake Lock) e avisa | **Testar em Android e iPhone reais**. Pelo navegador, o GPS em segundo plano não é garantido; só um app nativo resolve por completo. |
| I5 · cópias do banco | Cópia diária no disco (guarda 7), download na central | Guardar cópias **fora** do servidor: baixar regularmente, ou configurar envio automático para um armazenamento externo (exige conta e credenciais). Conferir no painel da Fly se os snapshots do volume `dados` estão ativos. |
| I6 · sessões e cabeçalhos | Cookie Secure, HSTS, X-Frame-Options, Permissions-Policy, CSP mínima; sessão da central 12 h | A CSP completa está em modo "só avisa". Depois de publicar, abra o app com Mapbox no navegador (ferramentas do desenvolvedor → Console); se não houver avisos de "Content Security Policy", ponha `CSP_ENFORCE = '1'` no `fly.toml`. Segunda etapa de login na central não foi feita. |
| I7 · guarda de dados | Prazos de GPS e chat configuráveis, **desligados** | Definir os prazos com o advogado, ligar em Configurações e escrever na Política de Privacidade. |
| I8 · contas falsas e não comparecimento | — (não feito) | Verificação de telefone exige serviço de SMS; avaliação do passageiro e regra de não comparecimento são decisões de negócio. |
| I9 · sem o app do passageiro | A central confirma o embarque (motivo obrigatório, auditado) | — |
| I10 · mapa dependente de site externo | Leaflet servido pelo próprio app | — |
| I11 · acessibilidade | Contraste do texto secundário ≥ 5:1; rótulos nos botões do mapa | Revisão completa com leitor de tela (TalkBack/VoiceOver) em celular real. |

## Melhorias

| Item | Situação |
|---|---|
| M1 · repasse manual | Continua manual até o Mercado Pago (split) ser configurado. |
| M2 · posição aproximada dos motoristas na tela pública | Mantida (≈110 m, só online). Decida se prefere esconder. |
| M3 · monitoramento | `GET /api/health` pronto (200 = banco respondendo). Falta cadastrar num serviço de alerta externo (ex.: UptimeRobot) com o seu e-mail ou WhatsApp. |
| M4 · arquivos de outras hospedagens | `render.yaml` e `.claude/launch.json` mantidos (não atrapalham). |
