# "Conteúdo do app" na Play Console — respostas sugeridas

Cada resposta é uma declaração sua perante o Google. O que está marcado como
**decisão sua** não foi decidido por ninguém ainda.

| Seção | Resposta sugerida | Observação |
|---|---|---|
| Política de privacidade | `https://assis-mototaxi.fly.dev/privacidade` | Hoje é **preliminar**: complete e revise com o advogado antes de enviar. |
| Acesso ao app | "Todo ou parte do app é restrito" → informar 1 passageiro e 1 motorista **aprovado** de teste | Crie as contas no app publicado. Instruções ao revisor: "O atendimento é em Assis Chateaubriand (PR); fora da área o app mostra o aviso de fora de área. O código de embarque aparece no app do passageiro." |
| Anúncios | **Não**, o app não tem anúncios | Nenhum SDK de anúncio no app. |
| Classificação do conteúdo (IARC) | Categoria: Utilitário/Produtividade/Comunicação/Outro. Violência, sexo, linguagem, drogas, jogos de azar: **Não**. Usuários interagem entre si (chat da corrida): **Sim**. Compartilha localização com outros usuários: **Sim** (motorista e passageiro durante a corrida). Compra de bens digitais: **Não** (corridas são serviço físico). | Confira as perguntas no questionário. |
| Público-alvo e conteúdo | **Decisão sua.** Sugestão: só **18 anos ou mais** | Os Termos aprovados não definem idade mínima; motoristas precisam ter 21+. |
| App de notícias | Não | |
| Apps governamentais | Não | |
| Recursos financeiros | Nenhum (o app não oferece empréstimo, conta, investimento etc.) | O pagamento de corridas pelo Mercado Pago não é "serviço financeiro". |
| Saúde | Não | |
| ID de publicidade | **Não** usa | O app não declara `AD_ID`. |
| Permissões de localização | Só em primeiro plano: **não** precisa da declaração de localização em segundo plano | Conferido no `.aab`: sem `ACCESS_BACKGROUND_LOCATION`. |
| Segurança dos dados | Ver [`SEGURANCA-DOS-DADOS.md`](SEGURANCA-DOS-DADOS.md) | |
| Conteúdo gerado pelo usuário | **Verificar** com a política de UGC da Play | O chat é só entre passageiro e motorista da mesma corrida; há "Informar um problema" e suporte, mas **não** há botão de bloquear usuário. |
