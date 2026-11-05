# Wagering

Processamento financeiro das operações de aposta enviadas por provedores de jogos de cassino online, com saldo materializado por wallet e ledger auditável.

## Participantes

**Provider**:
Empresa de jogos que envia as operações de aposta de suas rodadas, identificada por `providerId`.
_Avoid_: fornecedor, parceiro, cliente

**Player**:
Jogador dono das wallets, identificado por `playerId`.
_Avoid_: usuário, cliente, conta

**Round**:
Uma rodada de um jogo, à qual pertencem a aposta e seus desdobramentos (`roundId`).
_Avoid_: partida, sessão de jogo

## Dinheiro e saldo

**Money**:
Quantia exata em uma moeda ISO-4217, sempre com duas casas decimais.
_Avoid_: valor, amount (quando se fala do conceito inteiro)

**Wallet**:
Saldo de um Player em uma moeda, no máximo uma por Player e moeda.
_Avoid_: conta, carteira, account

**Ledger Entry**:
Registro imutável de um débito ou crédito em uma Wallet, com o saldo antes e depois.
_Avoid_: lançamento contábil genérico, movimento, log

**Reconciliation**:
Comparação entre o saldo armazenado da Wallet e o saldo reconstruído pelos Ledger Entries. Divergências são apenas sinalizadas, nunca corrigidas.
_Avoid_: ajuste, correção de saldo

## Operações

**Wager Transaction**:
Uma operação enviada por um Provider (ou a abertura interna) sobre uma Wallet, identificada externamente por `(providerId, externalTransactionId)`.
_Avoid_: aposta (que é só o kind BET), pedido, request

**Kind**:
O tipo de uma Wager Transaction: `OPENING`, `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK`.
_Avoid_: tipo de operação, action

**Opening**:
Wager Transaction interna que credita o saldo inicial de uma Wallet na sua criação. Nunca é aceita de um Provider.
_Avoid_: depósito, saldo inicial (como transação)

**Reference**:
A Wager Transaction anterior que um REFUND ou ROLLBACK reverte, resolvida por `(providerId, referenceExternalTransactionId)`.
_Avoid_: transação pai, original

**Reversal**:
Um REFUND ou ROLLBACK que desfaz o efeito de uma Reference, pelo valor integral e uma única vez por kind.
_Avoid_: estorno parcial, cancelamento

**Failure Code**:
Código estável e legível por máquina que explica por que uma Wager Transaction foi rejeitada ou falhou.
_Avoid_: mensagem de erro, motivo

## Entrega e confiabilidade

**Idempotency Key**:
Chave enviada pelo Provider que identifica uma operação. Repeti-la com o mesmo payload devolve o resultado original.
_Avoid_: request id, chave de deduplicação

**Replay**:
Resposta a uma operação repetida com a mesma Idempotency Key e o mesmo payload, devolvendo o resultado original sem novo efeito.
_Avoid_: reprocessamento, retry

**Idempotency Conflict**:
Mesma Idempotency Key com payload diferente. É erro, não Replay.
_Avoid_: duplicata

**Inbox Message**:
Registro persistente de uma mensagem já recebida da fila por um consumidor, usado para deduplicar a entrega at-least-once.

**Outbox Message**:
Evento de integração gravado na mesma transação da mudança financeira e publicado depois do commit.

**Integration Event**:
Fato publicado para fora do serviço (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`).
_Avoid_: domain event (quando sai do serviço), notificação
