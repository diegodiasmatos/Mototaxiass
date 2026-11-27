/**
 * Catálogo de notificações: para cada tipo (kind) usado em notify(), a
 * categoria, a prioridade, se é crítico e o que pode aparecer na TELA
 * BLOQUEADA do celular (push).
 *
 * Regra de privacidade do push: endereço, valor, conteúdo de mensagem e
 * dados pessoais NUNCA vão para a tela bloqueada. O texto completo fica só
 * dentro do app (central de notificações), depois do login.
 */

export type Category =
  | 'corrida' | 'pagamento' | 'financeiro' | 'conta' | 'cadastro' | 'suporte' | 'novidades'
  | 'admin_cadastros' | 'admin_ocorrencias' | 'admin_pagamentos' | 'admin_suporte' | 'admin_seguranca' | 'admin_sistema';
export type Priority = 'alta' | 'normal' | 'baixa';

export interface KindInfo {
  category: Category;
  priority: Priority;
  /** texto do push (tela bloqueada). Sem isso, usa o título e "Toque para ver os detalhes." */
  push?: { title: string; body?: string };
  /** o corpo é seguro para a tela bloqueada (não tem endereço, valor nem conteúdo pessoal) */
  bodySafe?: boolean;
}

const K = (category: Category, priority: Priority, extra: Partial<KindInfo> = {}): KindInfo => ({ category, priority, ...extra });

export const KINDS: Record<string, KindInfo> = {
  // ---------- corrida (passageiro e motorista) ----------
  ride_requested: K('corrida', 'normal', { bodySafe: true }),
  ride_redispatch: K('corrida', 'normal', { bodySafe: true }),
  ride_accepted: K('corrida', 'alta', { bodySafe: true }),
  driver_approaching: K('corrida', 'alta', { bodySafe: true }),
  driver_arrived: K('corrida', 'alta', { bodySafe: true }),
  driver_waiting: K('corrida', 'alta', { bodySafe: true }),
  ride_started: K('corrida', 'alta', { bodySafe: true }),
  confirm_required: K('corrida', 'alta', { bodySafe: true }),
  ride_completed: K('corrida', 'normal', { push: { title: 'Corrida concluída', body: 'Toque para ver o resumo.' } }),
  ride_cancelled: K('corrida', 'alta', { push: { title: 'Corrida cancelada', body: 'Toque para ver os detalhes.' } }),
  ride_offer: K('corrida', 'alta', { push: { title: '🏍️ Nova corrida disponível', body: 'Abra o app para ver e aceitar.' } }),
  pickup_updated: K('corrida', 'alta', { push: { title: '📍 Ponto de embarque alterado', body: 'Abra o app para ver o novo local.' } }),
  boarding_code_wrong: K('corrida', 'alta', { bodySafe: true }),
  chat: K('corrida', 'normal', { push: { title: '💬 Nova mensagem', body: 'Você tem uma mensagem na sua corrida.' } }),
  rating: K('corrida', 'baixa', { push: { title: '⭐ Nova avaliação', body: 'Toque para ver.' } }),
  issue: K('suporte', 'alta', { bodySafe: true }),
  issue_resolved: K('suporte', 'normal', { push: { title: 'Sua ocorrência foi analisada', body: 'Toque para ver o parecer.' } }),
  support_reply: K('suporte', 'normal', { push: { title: '🛟 Resposta do suporte', body: 'Toque para ler.' } }),

  // ---------- pagamento (passageiro) ----------
  payment_pending: K('pagamento', 'alta', { bodySafe: true }),
  payment_failed: K('pagamento', 'alta', { push: { title: 'Pagamento não aprovado', body: 'Toque para tentar outra forma de pagamento.' } }),
  refund: K('pagamento', 'normal', { push: { title: 'Estorno', body: 'Toque para ver os detalhes.' } }),

  // ---------- financeiro (motorista) ----------
  payout: K('financeiro', 'normal', { push: { title: '💸 Repasse realizado', body: 'Toque para ver o valor.' } }),
  debt: K('financeiro', 'normal', { push: { title: 'Comissão quitada', body: 'Toque para ver o saldo.' } }),
  mp_connected: K('financeiro', 'normal', { bodySafe: true }),

  // ---------- cadastro do motorista ----------
  application: K('cadastro', 'normal', { bodySafe: true }),
  application_approved: K('cadastro', 'alta', { bodySafe: true }),
  application_rejected: K('cadastro', 'alta', { push: { title: 'Cadastro não aprovado', body: 'Toque para ver o motivo.' } }),
  application_correction: K('cadastro', 'alta', { push: { title: 'Cadastro precisa de correção', body: 'Toque para ver o que corrigir.' } }),
  doc_expiring: K('cadastro', 'alta', { bodySafe: true }),
  doc_expired: K('cadastro', 'alta', { bodySafe: true }),

  // ---------- conta e segurança (não dá para desligar) ----------
  security: K('conta', 'alta', { bodySafe: true }),
  new_login: K('conta', 'alta', { push: { title: '🔐 Novo acesso à sua conta', body: 'Se não foi você, troque a senha agora.' } }),
  welcome: K('conta', 'baixa', { bodySafe: true }),
  profile_updated: K('conta', 'baixa', { bodySafe: true }),
  account_reactivated: K('conta', 'alta', { bodySafe: true }),

  // ---------- novidades (opcional, desligado até a pessoa ativar) ----------
  announcement: K('novidades', 'baixa', { bodySafe: true }),

  // ---------- central (administração) ----------
  new_driver: K('admin_cadastros', 'normal', { push: { title: 'Novo cadastro de mototaxista', body: 'Aguardando análise.' } }),
  new_passenger: K('admin_cadastros', 'baixa', { push: { title: 'Novo passageiro cadastrado' } }),
  deletion_request: K('admin_cadastros', 'normal', { push: { title: '🗑️ Pedido de exclusão de conta' } }),
  password_reset_request: K('admin_cadastros', 'normal', { push: { title: '🔑 Pedido de nova senha' } }),
  low_rating: K('admin_ocorrencias', 'normal', { push: { title: 'Avaliação baixa registrada' } }),
  ride_cancelled_admin: K('admin_ocorrencias', 'baixa'),
  payment_failed_admin: K('admin_pagamentos', 'alta', { push: { title: '⚠️ Falha em pagamento', body: 'Toque para ver a corrida.' } }),
  support: K('admin_suporte', 'normal', { push: { title: '🛟 Nova mensagem de suporte' } }),
  fraud_suspect: K('admin_seguranca', 'alta', { push: { title: '🚨 Possível fraude', body: 'Toque para analisar.' } }),
  webhook: K('admin_seguranca', 'alta', { push: { title: '⚠️ Webhook com assinatura inválida' } }),
  system_error: K('admin_sistema', 'alta', { push: { title: '⚠️ Erro no servidor', body: 'Toque para ver.' } }),
  doc_expired_admin: K('admin_cadastros', 'normal', { push: { title: 'CNH de mototaxista vencida' } }),
};

/** Tipos usados nas chamadas da central que têm nome igual ao de outro público. */
export const ADMIN_KIND_ALIAS: Record<string, string> = {
  ride_cancelled: 'ride_cancelled_admin',
  payment_failed: 'payment_failed_admin',
  issue: 'issue_admin',
  mp_connected: 'mp_connected_admin',
};
KINDS.issue_admin = K('admin_ocorrencias', 'alta', { push: { title: '⚠️ Nova ocorrência', body: 'Toque para analisar.' } });
KINDS.mp_connected_admin = K('admin_cadastros', 'baixa', { push: { title: 'Mototaxista conectou o Mercado Pago' } });

export function kindInfo(kind: string): KindInfo {
  return KINDS[kind] || K(kind.startsWith('admin') ? 'admin_sistema' : 'conta', 'normal');
}

/** Categorias, com o que se pode desligar. */
export interface CategoryInfo {
  label: string; description: string; roles: ('passenger' | 'driver' | 'admin')[];
  /** não dá para desligar a notificação dentro do app */
  lockInApp?: boolean;
  /** não dá para desligar o push */
  lockPush?: boolean;
  /** começa desligada (precisa de consentimento: novidades/promoções) */
  defaultOff?: boolean;
}
export const CATEGORIES: Record<Category, CategoryInfo> = {
  corrida: { label: 'Corridas', description: 'Mototaxista a caminho, chegada, embarque, conclusão, cancelamento, mensagens e, para motoristas, novas corridas.', roles: ['passenger', 'driver'], lockInApp: true },
  pagamento: { label: 'Pagamentos', description: 'Pagamento pendente, recusado e estornos.', roles: ['passenger'], lockInApp: true },
  financeiro: { label: 'Ganhos e repasses', description: 'Repasses, comissão e conta de recebimento.', roles: ['driver'] },
  cadastro: { label: 'Cadastro e documentos', description: 'Análise do cadastro e validade da CNH.', roles: ['driver'], lockInApp: true },
  suporte: { label: 'Suporte e ocorrências', description: 'Respostas do suporte e análise de ocorrências.', roles: ['passenger', 'driver'] },
  conta: { label: 'Conta e segurança', description: 'Senha alterada, acesso de aparelho novo e avisos de segurança.', roles: ['passenger', 'driver', 'admin'], lockInApp: true, lockPush: true },
  novidades: { label: 'Novidades e promoções', description: 'Comunicados da VAIRO. Desligado até você ativar.', roles: ['passenger', 'driver'], defaultOff: true },
  admin_cadastros: { label: 'Cadastros', description: 'Novos usuários, motoristas para analisar, pedidos de exclusão e de senha.', roles: ['admin'] },
  admin_ocorrencias: { label: 'Ocorrências', description: 'Ocorrências, contestações, avaliações baixas e cancelamentos.', roles: ['admin'] },
  admin_pagamentos: { label: 'Pagamentos', description: 'Falhas de cobrança, captura e estorno.', roles: ['admin'] },
  admin_suporte: { label: 'Suporte', description: 'Mensagens de suporte.', roles: ['admin'] },
  admin_seguranca: { label: 'Segurança', description: 'Possível fraude e webhooks inválidos.', roles: ['admin'], lockInApp: true },
  admin_sistema: { label: 'Sistema', description: 'Erros graves do servidor.', roles: ['admin'], lockInApp: true },
};
