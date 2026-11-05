---
status: accepted
---

# Lock pessimista por wallet como estratégia de concorrência

A unidade de concorrência é a `walletId` (§8). Cada operação financeira abre uma transação SQL e faz `SELECT … FOR UPDATE` **somente na linha da wallet afetada**: operações na mesma wallet são serializadas e wallets diferentes seguem em paralelo, sem lock global. Como defesa em profundidade, o banco também impõe `CHECK (balance >= 0)` e o `version` é incrementado a cada mudança de saldo, de modo que um bug de código não consegue produzir saldo negativo nem lost update silencioso.

## Considered Options

- **Lock otimista com retry limitado**: numa wallet muito disputada (hot wallet), gera muitos conflitos e retries, e o retry esgotado vira erro para o provedor. É justamente o cenário que o §8 e os testes de concorrência exercitam.
- **Update atômico condicionado** (`UPDATE … SET balance = balance - x WHERE balance >= x`): resolve o débito, mas não cobre a leitura consistente da referência, da idempotência e do ledger com `balanceBefore`/`balanceAfter` na mesma decisão.

## Consequences

- A vazão de uma única wallet é limitada pela duração da transação, então as transações precisam ser curtas (nenhuma chamada de rede dentro delas).
- Conflitos de lock (espera ou timeout) são medidos como métrica, conforme o §12.
