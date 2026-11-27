# Carteira do mototaxista, comissão e saques

Tudo é calculado no servidor (`server/payments.ts`, `server/wallet.ts`) a partir
do **livro-caixa** (`financial_transactions`). O livro só recebe inclusões:
nada é editado nem apagado. Correções são feitas com lançamentos compensatórios.

## Comissão

- O percentual vem de **Configurações → Comissão da plataforma** (hoje 15%) e
  fica gravado em cada corrida no momento da cotação.
- Ao concluir a corrida: comissão = arredondamento de preço × 15%; o
  mototaxista fica com o restante (85%).

| Forma | O que entra no livro | Efeito na carteira |
|---|---|---|
| Pix/cartão (pela VAIRO) | cobrança, comissão, `repasse_devido` (85%) | +85% no saldo |
| Pix/cartão com split (conta Mercado Pago do parceiro) | cobrança, comissão, `repasse_automatico` | nada (o dinheiro já caiu na conta dele) |
| Dinheiro | cobrança, comissão, `divida_comissao` (15%) | +15% de comissão pendente |

- **Digital só conta com o pagamento confirmado pelo provedor** (`pago`). Se a
  captura falhar na conclusão, nada é creditado. O crédito entra quando o
  Mercado Pago confirmar (webhook ou sincronização), uma única vez.
- **Corrida cancelada** não gera comissão nem crédito.
- **Estorno** de corrida digital já creditada gera `ajuste_repasse` (−85%) e
  `estorno_comissao`, uma vez. Se o parceiro já sacou, o saldo fica negativo e
  é compensado pelos próximos ganhos.

## Saldo

```
saldo bruto        = créditos digitais (+ ajustes) − saques reservados/pagos − repasses da central
comissão pendente  = comissões de dinheiro − descontadas + devolvidas (saque recusado)
disponível p/ saque = max(0, saldo bruto − comissão pendente)
```

## Saque

1. O mototaxista cadastra a **chave Pix**. Ela fica cifrada no banco; a
   chave CPF precisa ser o próprio CPF. Toda troca de chave avisa o
   mototaxista (aviso de segurança).
2. Ao pedir o saque, o app manda uma chave de idempotência; repetir o mesmo
   pedido não duplica. Numa única transação:
   - reserva o valor bruto (`saque_reserva`);
   - **desconta toda a comissão pendente** (`quitacao_divida`).
3. Regras:
   - um saque em aberto por vez (garantido também pelo banco);
   - **48 h** entre pedidos, contadas do pedido aceito, pelo relógio do servidor (ajustável em `withdrawal_interval_h`);
   - comissão pendente maior ou igual ao saldo → saque bloqueado, com explicação.
4. Status:
   - **Aguardando aprovação** → **Aprovado** → (**Em processamento**) → **Pago**, com comprovante obrigatório. O mesmo comprovante não paga dois saques.
   - **Rejeitado** (pela central, com justificativa) ou **Cancelado** (pelo mototaxista, enquanto aguarda): devolve o valor e a comissão descontada, e **não conta** para as 48 h.
5. Aprovar não é pagar: só "Registrar pagamento feito", com o identificador
   do Pix, marca como pago.

## Central (Financeiro → Saques dos mototaxistas)

- Lista por status.
- Totais:
  - comissão de pagamentos reais (os de teste aparecem à parte);
  - comissão de dinheiro a receber;
  - saldo devido aos parceiros;
  - saques em aberto.
- Detalhe do saque:
  - chave Pix completa (a abertura fica na auditoria);
  - situação da carteira e extrato.
- Alertas:
  - outro saque pago nas últimas 48 h;
  - chave Pix trocada menos de 24 h antes do pedido;
  - saldo negativo.
- Toda ação fica na auditoria, com quem fez e quando.

## Limites atuais

- A transferência é feita **à mão** (Pix pelo banco da VAIRO). A integração de
  pagamento automático de saques exige um provedor com API de transferência
  Pix e conta PJ. Não foi feita.
- A titularidade é conferida pela central no app do banco (nome do recebedor
  do Pix) antes de confirmar.
