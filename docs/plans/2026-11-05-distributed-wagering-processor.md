# Distributed Wagering Processor — Plano de Implementação

> **Para agentes:** use `superpowers:executing-plans` (ou subagent-driven-development) para executar tarefa por tarefa. Passos em checkbox (`- [ ]`).

**Objetivo:** serviço financeiro distribuído que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) vindas de HTTP e SQS, correto sob duplicação, fora de ordem e concorrência entre ≥ 3 instâncias.

**Arquitetura:** DDD em camadas (domain / application / infrastructure / interfaces). Um único use case `ProcessWagerTransaction` atende HTTP e SQS. Cada operação roda numa única transação SQL (inbox + transação + wallet + ledger + outbox). As invariantes ficam garantidas no schema do PostgreSQL. A publicação usa Transactional Outbox e workers seguros para múltiplas instâncias.

**Stack:** Bun 1.x (runtime, package manager e test runner) · TypeScript strict · NestJS · PostgreSQL · MikroORM (preferencial) · AWS SQS via LocalStack · Docker Compose · `decimal.js` para o `Money`.

**Spec:** https://github.com/junglegaming/backend-challenge (`README.md`). Toda referência "§N" abaixo aponta para a seção do README.

---

## Regra de ouro deste plano

Tudo o que está marcado como **[REQUISITO §N]** vem do README. Tudo o que está marcado como **[DECISÃO]** é uma escolha que o README deixa explicitamente para o candidato ("decisão sua", "a estratégia é sua escolha", "a taxonomia é sua"). Toda **[DECISÃO]** precisa estar justificada no `ARCHITECTURE.md`. Nada além disso entra no escopo.

## Restrições globais (§4, §5, §14 — copiadas do README)

- Bun 1.x · TypeScript estrito · NestJS · PostgreSQL · SQS via LocalStack ou MiniStack · Docker Compose · migrations versionadas **e reversíveis**.
- ORM: MikroORM (preferencial) ou TypeORM. **Prisma proibido.**
- Não usar `number`, `float` ou `double` para dinheiro. *(eliminatório)*
- Não usar cache em memória como garantia de idempotência. *(eliminatório)*
- Não confiar apenas em SQS FIFO para garantir consistência.
- Não publicar eventos antes do commit da transação financeira. *(eliminatório)*
- Não sobrescrever nem excluir lançamentos do ledger.
- Não usar lock global compartilhado por todas as wallets.
- Não implementar saldo como `read → calculate → update` sem controle de concorrência.
- A solução deve estar correta com múltiplas instâncias. *(eliminatório)*
- Unicidade, imutabilidade e não-negatividade **aplicadas no schema do banco**, não só no código.
- Domínio sem dependência de tipos do ORM nem de decorators do NestJS.
- Testes não podem substituir completamente PostgreSQL e SQS por mocks. *(eliminatório)*
- Autenticação **não vale pontos** (§2). Se não for implementada, documente e deixe um ponto de extensão.

## Mapa da avaliação (§14) → tarefas

| Área (pontos) | O que é observado | Tarefas |
|---|---|---|
| Correção financeira (20) | `Money`, saldo, ledger, reversões, reconciliação | 1, 2, 4, 6, 7 |
| Concorrência (20) | lost updates, hot wallet, múltiplas instâncias, locks | 4, 6, 13 |
| Idempotência (15) | dedup persistente, replay, payload conflitante | 4, 6, 8, 9 |
| Mensageria e falhas (15) | inbox, outbox, retry, DLQ, crash recovery, shutdown | 9, 10, 11, 13 |
| Modelagem e arquitetura (10) | invariantes encapsuladas, boundaries, portas, simplicidade | 1, 2, 3, 5 |
| Testes (10) | integração real, races, determinismo, falhas | todas + 13 |
| Observabilidade (5) | logs, métricas, health, diagnóstico | 12 |
| Documentação (5) | `README.md` (setup e comandos), `ARCHITECTURE.md` (decisões, trade-offs, limitações) | 14 |

## Decisões já fechadas (rodada 1 do grilling)

- ORM: MikroORM + EntitySchema → [ADR-0001](../adr/0001-mikro-orm-with-entity-schema.md)
- Concorrência: lock pessimista por wallet → [ADR-0002](../adr/0002-pessimistic-lock-per-wallet.md)
- Autenticação: não implementada, `AuthGuard` no-op → [ADR-0003](../adr/0003-authentication-not-implemented.md)
- Eventos: fila `wallet-events.fifo` → [ADR-0004](../adr/0004-integration-events-to-sqs-fifo-queue.md)
- SQS: LocalStack.
- Testes de integração: serviços do `docker-compose` (sem Testcontainers).
- Testes com ≥ 3 instâncias: `Bun.spawn` de 3 processos dentro do teste. O `docker compose --scale` fica documentado para demonstração manual.
- Documentação (README, ARCHITECTURE, ADRs, GLOSSARY) em pt-BR. Código e commits em inglês, comentários em pt-BR.
- Commits locais. Push só quando o usuário pedir.

## Decisões do candidato (recomendações, a justificar no ARCHITECTURE.md)

| Tema | Recomendação | Base no README |
|---|---|---|
| ORM | **MikroORM** com `em.transactional()` e mapeamento por `EntitySchema` na infra; mappers para `rehydrate` do domínio | §4 "preferencial" e "domínio não depende do ORM" |
| Concorrência | **Lock pessimista por wallet** (`SELECT … FOR UPDATE` na linha da wallet) dentro da transação, mais `CHECK (balance >= 0)` e `version` incrementado como defesa extra | §8 "a estratégia é sua escolha" |
| Autenticação | **Não implementar**: `AuthGuard` no-op + desenho com Keycloak documentado | §2 aceita explicitamente |
| Emulador SQS | **LocalStack** | §4 |
| `payloadHash` | SHA-256 do JSON canônico (chaves ordenadas recursivamente) dos campos de negócio: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId` | §9 "algoritmo deve estar documentado" |
| Status HTTP | 400/422 payload inválido · 409 conflito de idempotência / wallet duplicada · 422 rejeição de negócio (com `failureCode`) · 202 `PENDING_REFERENCE` · 503 falha transitória · 200/201 sucesso | §9 "mapeamento é decisão sua, mas distinguir" |
| `failureCode` | Ex.: `INVALID_PAYLOAD`, `CURRENCY_MISMATCH`, `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_NOT_PROCESSED`, `ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `WALLET_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, `INTERNAL_KIND_NOT_ALLOWED` | §7.2 "a taxonomia é sua" |
| Limite do `PENDING_REFERENCE` | máx. N tentativas com backoff exponencial e teto (ex.: 10 tentativas, base 1s, teto 5min) | §7.1 "definido e justificado por você" |
| Destino dos eventos da outbox | O README **não define** o destino. Proposta: fila SQS própria de eventos (ex.: `wallet-events.fifo`), documentada como interpretação | §3 "interpretação adicional deve ser documentada" |
| Replay com "saldo observado" | Gravar `balance_after_snapshot` na própria transação (vale também para LOSS e REJECTED, que não têm ledger) | §7 regra 7 |

## Estrutura de arquivos

```
docker-compose.yml               # postgres, localstack (+ init das filas), app x3 (profile)
localstack/init-sqs.sh           # cria wager-transactions.fifo, -dlq.fifo e redrive (maxReceiveCount)
src/
  domain/
    money/money.ts
    wallet/wallet.ts
    ledger/wallet-ledger-entry.ts
    wagering/wager-transaction.ts, kinds.ts, failure-code.ts
    messaging/inbox-message.ts, outbox-message.ts
    events/integration-event.ts, wager-transaction-processed.ts, wager-transaction-rejected.ts,
           wallet-balance-changed.ts, wager-transaction-pending-reference.ts
    errors.ts                    # DomainError, InvalidTransactionStateError, CurrencyMismatchError…
  application/
    ports/                       # WalletRepository, WagerTransactionRepository, LedgerRepository,
                                 # InboxRepository, OutboxRepository, UnitOfWork, Clock, IdGenerator, EventPublisher
    process-wager-transaction.use-case.ts
    create-wallet.use-case.ts
    reconcile-wallet.use-case.ts
    queries/*.ts
    payload-hash.ts
  infrastructure/
    persistence/mikro-orm.config.ts, schemas/*.ts, mappers/*.ts, repositories/*.ts
    persistence/migrations/*.ts
    sqs/sqs-consumer.ts, sqs-publisher.ts, error-classifier.ts
    workers/outbox-publisher.worker.ts, pending-reference.worker.ts
    observability/logger.ts, metrics.ts
  interfaces/http/
    wallets.controller.ts, wagering.controller.ts, providers.controller.ts, health.controller.ts
    auth/auth.guard.ts (no-op), dto/*.ts, http-exception.filter.ts
  main.ts, app.module.ts
test/
  unit/  integration/  concurrency/  helpers/
README.md  ARCHITECTURE.md
```

## Pontos de atenção para a revisão

1. **Mesma Idempotency-Key chegando ao mesmo tempo em duas instâncias:** a segunda bate na unique constraint, relê o registro e devolve replay (ou 409 se o hash for diferente), nunca 500.
2. **REFUND e ROLLBACK concorrentes sobre a mesma BET:** só um pode ser `PROCESSED`. Isso é garantido por índice único parcial, não só pelo lock.
3. **Redelivery do SQS depois do commit e antes do ack:** a inbox detecta o reprocessamento e faz ack, sem efeito duplicado.
4. **Entrada monetária malformada** (`"1e2"`, `"10.001"`, `"-5.00"`, `" "`, `"Infinity"`, número JSON em vez de string): 400 com `INVALID_PAYLOAD`.
5. **`kind: "OPENING"` submetido via API ou fila:** rejeitado com `INTERNAL_KIND_NOT_ALLOWED`.

---

### Tarefa 0: Bootstrap do projeto e infraestrutura local

**Arquivos:** `package.json`, `tsconfig.json` (`strict: true`, `experimentalDecorators`, `emitDecoratorMetadata`), `docker-compose.yml`, `localstack/init-sqs.sh`, `src/main.ts`, `src/app.module.ts`, `src/infrastructure/persistence/mikro-orm.config.ts`.

- [ ] Projeto Bun + NestJS rodando com `bun run start`.
- [ ] Compose com `postgres` e `localstack` (SQS). O script de init cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wallet-events.fifo` (ADR-0004), com `RedrivePolicy.maxReceiveCount` **[REQUISITO §10]**.
- [ ] Scripts: `test`, `test:unit`, `test:integration`, `test:concurrency`, `migration:up`, `migration:down`.
- [ ] Verificação: `docker compose up -d && bun run start` sobe sem erro.

### Tarefa 1: `Money` (value object)

**Arquivos:** `src/domain/money/money.ts`, `test/unit/money.test.ts`
**Produz:** `Money.from({amount, currency})`, `Money.zero(c)`, `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON(): MoneyProps`, `toString()` **[REQUISITO §6.1]**.

- [ ] Testes (escreva antes):
  - `Money.from({amount:"25.00",currency:"BRL"}).toJSON()` → `{amount:"25.00",currency:"BRL"}`.
  - `"25"` e `"25.0"` normalizam para `"25.00"`, com escala fixa de 2.
  - rejeita `"NaN"`, `"Infinity"`, `"1e2"`, `""`, `"10.001"`, `"abc"` e `"-5.00"` em contrato de entrada.
  - `add`/`subtract` entre BRL e USD lançam `CurrencyMismatchError`.
  - imutabilidade: `a.add(b)` não altera `a`.
  - precisão: `"0.10" + "0.20"` resulta exatamente em `"0.30"`.
- [ ] Implementar com construtor `private` e `Decimal` interno. Valores negativos só são possíveis via `negate`/`subtract` (uso interno), nunca na entrada.
- [ ] `bun test test/unit/money.test.ts` → PASS.

### Tarefa 2: Agregados do domínio e regras de negócio

**Arquivos:** `wallet.ts`, `wallet-ledger-entry.ts`, `wager-transaction.ts`, `kinds.ts`, `failure-code.ts`, `errors.ts`, mais testes unitários de cada um.
**Produz:** `Wallet.open/rehydrate/debit/credit`, `WalletLedgerEntry.create/rehydrate/isBalanced`, `WagerTransaction.create/rehydrate/markProcessed/markPendingReference/reject/fail/isTerminal/affectsBalance/requiresReference/matchesPayload/ledgerDirectionFor` **[REQUISITO §6.0–6.4]**.

- [ ] Todos com construtor `private` e factories estáticas. `rehydrate` **não** revalida transições.
- [ ] Testes da `Wallet`: `version` começa em 1 e só incrementa quando o saldo muda; `debit` acima do saldo lança `InsufficientFundsError`; moeda diferente lança `CurrencyMismatchError`; `debit`/`credit` devolvem o `WalletLedgerEntry` com `balanceBefore`/`balanceAfter` corretos.
- [ ] Testes do `WalletLedgerEntry`: `create` lança erro se `balanceBefore ± money ≠ balanceAfter`; nenhum setter ou método de transição.
- [ ] Testes do `WagerTransaction`:
  - nasce `PENDING`; REFUND/ROLLBACK sem `referenceExternalTransactionId` são rejeitados em `create`; `OPENING` só via factory interna.
  - transições a partir de `PROCESSED|REJECTED|FAILED` lançam `InvalidTransactionStateError`.
  - `affectsBalance()` é false para LOSS; `requiresReference()` é true só para REFUND e ROLLBACK.
  - `ledgerDirectionFor`: BET→DEBIT, WIN→CREDIT, REFUND→CREDIT, ROLLBACK→inverso da referência (BET→CREDIT, WIN→DEBIT, REFUND→DEBIT).
  - `matchesPayload(hash)` diferencia payloads divergentes.
- [ ] Serviço de domínio (ou método) que valida a referência **[REQUISITO §7]**: mesmo provider, player, wallet, moeda e rodada; REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND; referência deve estar `PROCESSED`; valor igual; não pode ter sido revertida antes pelo mesmo tipo. Um teste por regra, cada um com seu `failureCode`.
- [ ] Reversão que deixaria o saldo negativo → `REVERSAL_WOULD_OVERDRAW`, diferente de `INSUFFICIENT_FUNDS` **[REQUISITO §7 regra 9]**.
- [ ] Documentar o diagrama de transições de status (vai para o ARCHITECTURE.md).

### Tarefa 3: Eventos de integração, Inbox e Outbox (domínio)

**Arquivos:** `src/domain/events/*.ts`, `src/domain/messaging/*.ts`, testes unitários.

- [ ] `IntegrationEvent<T>` abstrata com construtor `protected` e `toJSON()` no envelope do §11. Uma subclasse por evento, com `eventType` e `version` **no tipo**: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`.
- [ ] `data` carrega `MoneyProps` (string), nunca `Money`. Teste: `JSON.parse(JSON.stringify(evt))` preserva `"25.00"`.
- [ ] `InboxMessage.receive/rehydrate/isProcessed/markProcessed`; `OutboxMessage.enqueue/rehydrate/isPending/isDue/markPublished/scheduleRetry`. Teste: o backoff de `scheduleRetry` cresce exponencialmente e incrementa `attempts`.

### Tarefa 4: Schema, constraints e migrations

**Arquivos:** `src/infrastructure/persistence/migrations/*.ts`, `test/integration/schema.test.ts`
**[REQUISITO §5.9, §6]**: as garantias ficam no banco.

- [ ] `wallets`: `balance_amount NUMERIC(20,2) CHECK (balance_amount >= 0)`, `currency CHAR(3)`, `version INT CHECK (version >= 1)`, `UNIQUE (player_id, currency)`.
- [ ] `wager_transactions`: `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, `CHECK` de `kind`/`status`, `amount NUMERIC(20,2) CHECK (amount > 0)`, `failure_code`, `reference_transaction_id` FK, `balance_after_snapshot`, `attempts`, `next_attempt_at`.
- [ ] Índice único parcial anti dupla reversão: `UNIQUE (reference_transaction_id, kind) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`.
- [ ] `wallet_ledger_entries`: `UNIQUE (wallet_id, transaction_id)` (no máximo um lançamento por wallet por transação), `CHECK (balance_after >= 0)`, `CHECK` aritmético (`balance_before ± amount = balance_after` conforme `direction`), e **trigger que bloqueia UPDATE e DELETE** (imutabilidade).
- [ ] `inbox_messages`: `PRIMARY KEY (consumer_name, message_id)`.
- [ ] `outbox_messages`: índice em `(next_attempt_at) WHERE published_at IS NULL`.
- [ ] Testes de integração (Postgres real): `up` → `down` → `up` funciona; cada constraint rejeita a violação (saldo negativo, wallet duplicada, ledger UPDATE/DELETE, dupla reversão, lançamento desbalanceado).

### Tarefa 5: Persistência (MikroORM) e portas

**Arquivos:** `src/application/ports/*.ts`, `src/infrastructure/persistence/{schemas,mappers,repositories}/*.ts`, testes de integração dos mappers.

- [ ] Portas no `application/` e implementações MikroORM em `infrastructure/`. O domínio não importa nada de ORM nem de Nest.
- [ ] `Money` persistido como `NUMERIC` + `currency` e lido como **string** (nunca `number`), reidratado via `Money.from`.
- [ ] `WalletRepository.findByIdForUpdate(id)` usando `LockMode.PESSIMISTIC_WRITE`.
- [ ] `UnitOfWork.run(fn)` sobre `em.transactional()` (fork de `EntityManager` por operação).
- [ ] Teste: ida e volta (save → rehydrate) preserva todos os campos e `"0.10"` continua exato.

### Tarefa 6: Use case `ProcessWagerTransaction` (núcleo)

**Arquivos:** `src/application/process-wager-transaction.use-case.ts`, `payload-hash.ts`, `test/integration/process-wager-transaction.test.ts`
**Consome:** portas da Tarefa 5. **Produz:** `execute(cmd, ctx: {correlationId, inbox?: {consumerName, messageId, payloadHash}}): Promise<WagerResult>`.

Fluxo numa única transação SQL **[REQUISITO §6.5, §11]**:
1. Se houver `inbox` e ela já tiver sido processada, retorna sem efeito (ack).
2. Busca por `idempotencyKey`: hash igual → **replay** com o resultado original e `idempotentReplay: true`; hash diferente → `IdempotencyConflictError`.
3. `SELECT … FOR UPDATE` na wallet (lock só daquela wallet).
4. Resolve a referência por `(providerId, referenceExternalTransactionId)`. Se ausente → `PENDING_REFERENCE` + evento `WagerTransactionPendingReference`.
5. Aplica a regra: debit/credit + ledger, ou LOSS (sem ledger), ou `reject(code)` (sem ledger).
6. Grava a transação, a wallet (`version++` só se o saldo mudou), o ledger, a outbox (`WagerTransactionProcessed` | `WagerTransactionRejected` + `WalletBalanceChanged` só se o saldo mudou) e marca a inbox.
7. Se o commit falhar por unique violation na `idempotency_key` (corrida entre instâncias), relê e aplica o passo 2.

- [ ] Testes de integração (Postgres real), um por regra do §7: BET, WIN, LOSS (gera `WagerTransactionProcessed` e nenhum ledger), REFUND, ROLLBACK de BET/WIN/REFUND, dupla reversão, valor divergente, referência de outra rodada/player, saldo insuficiente, reversão que estouraria o saldo, replay devolvendo o saldo original, conflito de payload.
- [ ] Teste de atomicidade: forçar erro depois do ledger e antes da outbox → nada persiste.
- [ ] Teste do `payloadHash`: mesma entrada com chaves em outra ordem → mesmo hash; o header não entra.

### Tarefa 7: Wallets, consultas e reconciliação

**Arquivos:** `create-wallet.use-case.ts`, `reconcile-wallet.use-case.ts`, `queries/*.ts`, testes de integração.

- [ ] `CreateWallet`: `initialBalance > 0` → transação `OPENING` + ledger `CREDIT` **na mesma transação SQL**. Wallet duplicada (`player_id`+`currency`) → conflito **[REQUISITO §9]**.
- [ ] Ledger paginado com **cursor opaco e estável** (base64 de `(created_at, id)`), `limit` com teto.
- [ ] Consulta por `transactionId` e por `(providerId, externalTransactionId)`.
- [ ] Reconciliação: compara o saldo armazenado com o saldo recalculado pelo ledger. Divergência → **log + métrica + `consistent:false`**, sem correção **[REQUISITO §9]**. Teste: inserir divergência direto no banco (desabilitando o CHECK só no teste) → `consistent:false`, contador incrementado e saldo inalterado.

### Tarefa 8: API HTTP

**Arquivos:** `src/interfaces/http/**`, `test/integration/http.test.ts`

- [ ] Endpoints do §9: `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger`, `GET /wagering/transactions/:transactionId`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId`, `POST /wagering/transactions`, `POST /wallets/:walletId/reconciliation`.
- [ ] `Idempotency-Key` obrigatório (sem ele → 400). Validação de DTO: `amount` precisa ser string; `kind: OPENING` é rejeitado.
- [ ] Exception filter único que aplica o mapeamento de status de forma **consistente entre endpoints**, com corpo `{ failureCode, message }`.
- [ ] `AuthGuard` no-op registrado (ponto de extensão do §2). Health fica fora do guard.
- [ ] Testes: cada classe de erro devolve o status mapeado; replay devolve o mesmo corpo com `idempotentReplay:true`.

### Tarefa 9: Consumidor SQS

**Arquivos:** `src/infrastructure/sqs/sqs-consumer.ts`, `error-classifier.ts`, `test/integration/sqs-consumer.test.ts` (LocalStack real)

- [ ] Long polling em `wager-transactions.fifo` chamando **o mesmo use case** da Tarefa 6, com a inbox `(consumerName, messageId)` **[REQUISITO §10]**.
- [ ] `DeleteMessage` (ack) **somente após o commit**.
- [ ] Classificação: erro de negócio → terminal, ack; erro transitório (DB/SQS fora) → não faz ack e aplica `ChangeMessageVisibility` com backoff; erro permanente (payload que não parseia etc.) → DLQ pelo `maxReceiveCount` (ou envio explícito) e métrica.
- [ ] `SIGTERM`: para o polling, conclui as mensagens em andamento até um timeout e devolve a visibilidade (`VisibilityTimeout=0`) das que não terminarem. Usar `app.enableShutdownHooks()`.
- [ ] Testes: redelivery da mesma mensagem → um único efeito; erro transitório → retry e depois sucesso; erro permanente → mensagem cai na DLQ; SIGTERM com mensagem em voo.

### Tarefa 10: Worker publicador da Outbox

**Arquivos:** `src/infrastructure/workers/outbox-publisher.worker.ts`, `sqs-publisher.ts`, `test/integration/outbox.test.ts`

- [ ] Claim em lote com `SELECT … FOR UPDATE SKIP LOCKED WHERE published_at IS NULL AND next_attempt_at <= now()`, publicação e `markPublished`. Em falha, `scheduleRetry` **[REQUISITO §11]**.
- [ ] Semântica at-least-once: `eventId` no envelope permite que o consumidor deduplique ("publicação duplicada continua segura"). Documentar.
- [ ] Testes: dois publishers concorrentes sobre a mesma outbox → cada evento publicado, sem perda; processo morto depois do commit e antes de publicar → outra instância publica.

### Tarefa 11: Worker de `PENDING_REFERENCE`

**Arquivos:** `src/infrastructure/workers/pending-reference.worker.ts`, teste de integração.

- [ ] Agendado e com claim via `SKIP LOCKED`. Reexecuta o use case para transações `PENDING_REFERENCE` vencidas (`next_attempt_at`), com backoff exponencial **[REQUISITO §7.1]**.
- [ ] Limite esgotado → `REJECTED` com `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.
- [ ] Testes: ROLLBACK chega antes da BET → `PENDING_REFERENCE`; a BET chega; o worker processa → `PROCESSED` e saldo correto. Sem a BET → `REJECTED` após o limite.

### Tarefa 12: Observabilidade

**Arquivos:** `src/infrastructure/observability/*.ts`, `health.controller.ts`

- [ ] Logs JSON (ex.: `pino`) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Redaction de payload financeiro completo **[REQUISITO §12]**.
- [ ] Métricas (ex.: `prom-client` em `GET /metrics`): transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag e latência de processamento. Mais divergências de reconciliação (§9).
- [ ] `GET /health/live` (processo) e `GET /health/ready` (Postgres + SQS), sem autenticação.

### Tarefa 13: Testes de concorrência e resiliência (§13)

**Arquivos:** `test/concurrency/*.test.ts`, `test/helpers/spawn-instances.ts`. Paralelismo real, sem mocks sequenciais.

- [ ] 1. A mesma BET enviada **50× em paralelo** (HTTP) → um único débito; as demais respostas são replay.
- [ ] 2. Cenário obrigatório do §8: saldo 100.00, duas BETs de 80.00 simultâneas → uma `PROCESSED`, uma `REJECTED/INSUFFICIENT_FUNDS`, saldo 20.00, exatamente **1** débito no ledger.
- [ ] 3. Wallets distintas em paralelo → todas processadas sem bloqueio mútuo.
- [ ] 4. **≥ 3 instâncias** (`Bun.spawn` de 3 processos ou 3 réplicas no compose) consumindo a mesma fila e martelando a mesma wallet.
- [ ] 5. Worker morto **depois do commit e antes do ack** (kill do processo via hook de teste) → redelivery sem efeito duplicado.
- [ ] 6. Dois publishers sobre a mesma outbox.
- [ ] 7. ROLLBACK/REFUND entregue antes da referência.
- [ ] 8. Reinício do serviço e comprovação da consistência final.
- [ ] Toda suíte termina afirmando: **`wallet.balance == saldo reconstruído pelo ledger`** **[REQUISITO §13]**.

### Tarefa 14: Documentação

- [ ] `README.md`: pré-requisitos, `docker compose up`, migrations, como rodar app, workers e cada suíte de teste, e como subir 3 instâncias.
- [ ] `ARCHITECTURE.md`: escolha do ORM, mapeamento do `Money` e estratégia transacional (§4); estratégia de concorrência (§8); decisão de autenticação (§2); diagrama de transições; taxonomia de `failureCode`; mapeamento HTTP; algoritmo do `payloadHash`; limite/TTL do PENDING_REFERENCE; destino dos eventos; todas as interpretações adicionais (§7); trade-offs e limitações.

### Tarefa 15 (opcional, diferencial): Teste de carga

- [ ] `bun run test:load` registrando ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag **[REQUISITO §14 diferenciais]**. Só depois de tudo acima estar pronto.

---

## Checklist final: falhas eliminatórias (§14)

- [ ] Nenhum `number` para dinheiro (grep por `amount: number`, `parseFloat`, `Number(` em código monetário).
- [ ] Saldo negativo impossível (CHECK no banco + teste 2).
- [ ] Sem débito ou crédito duplicado (testes 1, 4, 5).
- [ ] Idempotência persistida no banco (unique + inbox), nunca em memória.
- [ ] Correta com múltiplas instâncias (teste 4).
- [ ] Evento só via outbox, publicado depois do commit.
- [ ] Ledger auditável e imutável (trigger + testes).
- [ ] Testes de integração usam Postgres e LocalStack reais.
