# Segurança dos dados (Play Console) — rascunho a partir do código

Levantado do código do app em 25/11/2026. **As respostas na Play Console são
declarações suas**: confira cada item (e com o advogado, se houver dúvida).
Definições da Play: *coletar* = enviar o dado para fora do aparelho;
*compartilhar* = transferir para terceiros, **exceto** prestadores de serviço
que processam em seu nome (hospedagem, pagamento, mapas) e transferências que o
próprio usuário inicia e espera (ex.: o motorista ver o ponto de embarque).

## Perguntas gerais

| Pergunta | Resposta sugerida | Base no app |
|---|---|---|
| O app coleta ou compartilha dados do usuário? | **Sim** | conta, corridas, localização |
| Os dados são criptografados em trânsito? | **Sim** | só HTTPS (`force_https` e HSTS) |
| O usuário pode pedir a exclusão dos dados? | **Sim** | Perfil → Excluir minha conta; web: `/excluir-conta` |
| URL de exclusão de conta | `https://assis-mototaxi.fly.dev/excluir-conta` | página pública, sem login |

## Tipos de dados

| Categoria Play | Tipo | Coletado | Compartilhado | Obrigatório? | Finalidade |
|---|---|---|---|---|---|
| Local | Local exato | Sim | Não* | Sim (para pedir/receber corrida) | Funcionalidade do app |
| Local | Local aproximado | Sim | Não* | Sim | Funcionalidade do app |
| Informações pessoais | Nome | Sim | Não* | Sim | Gerenciamento da conta; funcionalidade |
| Informações pessoais | Endereço de e-mail | Sim | Não | Sim | Gerenciamento da conta; comunicações |
| Informações pessoais | IDs de usuário | Sim | Não | Sim | Gerenciamento da conta |
| Informações pessoais | Endereço | Sim (só motoristas) | Não | Sim p/ motoristas | Verificação do motorista |
| Informações pessoais | Número de telefone | Sim | Não | Sim | Conta; suporte; recuperação de senha |
| Informações pessoais | Outras informações (CPF, data de nascimento, dados da CNH e da moto) | Sim (motoristas) | Não | Sim p/ motoristas | Verificação; prevenção de fraude |
| Informações financeiras | Histórico de compras (corridas e pagamentos) | Sim | Não* | Sim | Funcionalidade; prevenção de fraude |
| Informações financeiras | Dados do cartão | **Verificar** | — | — | O cartão é digitado no Mercado Pago; confirme se o app recebe algum dado do cartão |
| Fotos e vídeos | Fotos | Sim (foto de perfil; documentos e selfie do motorista) | Não | Opcional p/ passageiro; obrigatório p/ motorista | Conta; verificação |
| Mensagens | Outras mensagens no app (chat da corrida) | Sim | Não* | Opcional | Funcionalidade |
| Atividade no app | Outro conteúdo gerado (avaliações, ocorrências, suporte) | Sim | Não | Opcional | Funcionalidade; suporte |
| IDs do dispositivo | **Verificar** | Inscrição de notificação (endereço do serviço de push) | Não | Opcional | Notificações |

\* O motorista vê o primeiro nome, a foto e o ponto de embarque do
passageiro; o passageiro vê nome, foto, moto, placa e posição do motorista.
Pela definição da Play isso é transferência esperada pelo usuário, não
"compartilhamento". Mercado Pago (pagamento), Fly.io (hospedagem) e Mapbox /
Google / OpenStreetMap (mapas) são prestadores de serviço.

**Não coletados:** contatos, agenda, SMS, arquivos, áudio, saúde, ID de
publicidade, histórico de navegação, apps instalados.

## Retenção

Hoje os dados ficam guardados enquanto a conta existir (os prazos de guarda
estão desligados na central). Quando definir prazos com o advogado, atualize a
Política de Privacidade e este formulário.
