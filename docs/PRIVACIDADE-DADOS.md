# VAIRO — dados pessoais armazenados, finalidade e retenção

Inventário dos dados pessoais que o sistema guarda, para que servem, quem
acessa e por quanto tempo. Reflete o código desta versão (banco SQLite,
`server/db.ts`). Os prazos marcados como "configurável" são ajustados na
central → ⚙️ Configurações → **Privacidade e sessões**.

Este documento descreve o que o software faz. A definição das bases legais, a
política de privacidade publicada e o atendimento aos titulares são
responsabilidade do controlador (a empresa que opera o VAIRO) e devem ser
validados por um profissional de proteção de dados.

## Dados por categoria

| Dado | Onde fica | Para que serve | Quem acessa | Quanto tempo |
|---|---|---|---|---|
| Nome, e-mail, telefone | `users` | Conta, contato da plataforma, recibos | O próprio titular; a central. O motorista vê só o **primeiro nome** e a foto do passageiro | Enquanto a conta existir; apagados na anonimização |
| CPF (opcional para passageiro; motorista) | `users.cpf` | Identificação do motorista parceiro | Central | Enquanto a conta existir; apagado na anonimização |
| Senha | `users.password_hash` | Login | Ninguém (só o hash scrypt é guardado) | Enquanto a conta existir; substituída por valor aleatório na anonimização |
| Foto de perfil | `users.photo` | Identificação na corrida | Titular, a outra parte da corrida, central | Enquanto a conta existir |
| Sessões de login | `sessions` (só o **hash** do token) | Manter o login | Ninguém lê o token; o cookie é HttpOnly | 30 dias sem uso / máx. 90 dias (central: 12 h / 7 dias) — configurável |
| Documentos do motorista (CNH, CRLV, selfie) | arquivos em `DATA_DIR/uploads/`, índice em `driver_documents` | Aprovação do cadastro | Só a central, por link assinado que expira em 10 min | Enquanto a conta existir; arquivos apagados na anonimização |
| Data de nascimento, endereço, dados da moto | `drivers` | Cadastro e identificação do veículo pelo passageiro (placa, modelo, cor) | Central; o passageiro da corrida vê moto, placa e cor | Enquanto a conta existir; apagados na anonimização |
| Conexão Mercado Pago do motorista | `drivers.mp_*` (tokens cifrados AES-256-GCM) | Repasse automático (split) | Ninguém lê os tokens; uso só pelo servidor | Até desconectar ou anonimizar |
| **Última posição do motorista** | `drivers.last_lat/lng` | Chamar o motorista mais próximo; mostrar o motorista ao passageiro **durante** a corrida | Servidor (despacho); o passageiro da corrida só entre o aceite e o fim da viagem | Só é gravada com o motorista online ou em corrida; apagada **6 h** após ficar offline — configurável |
| **Histórico de GPS da corrida** | `ride_locations` | Acompanhamento ao vivo e análise de ocorrências | A outra parte da corrida, ao vivo; a central (cada consulta fica na auditoria) | Apagado **30 dias** após o fim da corrida — configurável. Mantido enquanto houver ocorrência aberta |
| Posição do passageiro durante a corrida | `ride_locations` (`who = 'passenger'`) | Mostrar ao motorista onde buscar | Só o motorista da corrida, ao vivo | Só é gravada com motorista a caminho ou em viagem; mesma retenção acima |
| Endereços e trajeto da corrida | `rides`, `ride_quotes` | Executar e cobrar a corrida; recibo | Titular, motorista da corrida, central | Mantidos com a corrida (obrigação fiscal); descaracterizados na anonimização (texto removido, ponto arredondado a ~1 km) |
| Locais favoritos | `favorites` | Atalho do passageiro | Só o titular | Até o titular apagar; apagados na anonimização |
| Mensagens do chat | `ride_messages` | Comunicação durante a corrida | As duas partes e a central | Mantidas com a corrida; texto removido na anonimização |
| Ocorrências e suporte | `ride_issues`, `support_messages` | Atendimento e disputas | Titular e central | Mantidas para atendimento; texto removido na anonimização |
| Avaliações | `ratings` | Qualidade do serviço | Motorista (nota), central | Nota mantida; comentário removido na anonimização |
| Notificações e inscrições de push | `notifications`, `push_subscriptions` | Avisos | Só o titular | Apagadas na anonimização |
| Pagamentos, repasses, livro-caixa | `payments`, `payouts`, `financial_transactions` | Obrigação fiscal e contábil | Central | **Mantidos** (não identificam a pessoa após a anonimização da conta) |
| Registros da central | `admin_audit_logs` | Prestação de contas das ações administrativas | Central | Mantidos |
| Cópias de segurança | `DATA_DIR/backups/` | Recuperação de desastre | Quem tem acesso ao servidor | 7 cópias diárias (configurável) + uma antes de cada migração |

## Minimização aplicada

- A posição do motorista **não é gravada** quando ele está offline e sem corrida.
- A posição do passageiro **não é gravada** enquanto ninguém aceitou a corrida.
- Corridas encerradas **não expõem** a posição do motorista ao passageiro (antes
  desta versão, o histórico de corridas mostrava a posição *atual* dele).
- O log de erros do servidor registra só método e caminho, sem corpo da
  requisição, parâmetros de busca ou coordenadas.

## Procedimentos

### Anonimização a pedido do titular

Central → Passageiros (ou Mototaxistas → abrir o cadastro) → **Anonimizar
(LGPD)** → digitar `ANONIMIZAR`. Rota: `POST /api/admin/users/:id/anonymize`.

- Recusada se houver corrida em andamento ou em disputa.
- Apaga ou descaracteriza: nome, e-mail, telefone, CPF, foto, senha, sessões,
  push, favoritos, notificações, cotações não usadas, GPS, mensagens, textos de
  suporte e ocorrências, comentários de avaliação, endereços e trajeto das
  corridas do passageiro e, para motorista, documentos (arquivos), dados
  pessoais e da moto e a conexão Mercado Pago.
- Mantém, sem identificar a pessoa: corridas (valores, datas, categoria),
  pagamentos, repasses e livro-caixa.
- Fica registrada na auditoria. **Não pode ser desfeita.**

### Limpeza automática

Roda 1 minuto depois de o servidor subir e depois a cada 10 minutos
(`server/maintenance.ts`). Apaga em lotes de 500 linhas e nunca toca corridas
pendentes de pagamento, procurando motorista, aceitas, em andamento,
aguardando confirmação ou em disputa, nem corridas com ocorrência aberta.

## O que ainda não existe

- Exclusão/anonimização solicitada pelo próprio usuário dentro do app (hoje é
  pela central, a pedido via suporte).
- Exportação dos dados do titular (portabilidade).
- Retenção automática para mensagens do chat, notificações e registros de
  auditoria (hoje ficam até a anonimização da conta).
- As cópias de segurança contêm dados de contas anonimizadas até saírem do
  rodízio (7 dias por padrão).
