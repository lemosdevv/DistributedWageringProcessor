# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) enviadas por provedores de jogos, via HTTP e via fila SQS. Ele continua correto com mensagens duplicadas, fora de ordem e processadas ao mesmo tempo por várias instâncias.

Solução do [desafio técnico da Jungle Gaming](https://github.com/junglegaming/backend-challenge). As decisões, trade-offs e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

**Stack:** Bun 1.x · TypeScript (strict) · NestJS · PostgreSQL 17 · MikroORM · AWS SQS (LocalStack) · Docker Compose.

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose

## Como rodar

```bash
bun install
bun run infra:up        # PostgreSQL (porta 5433) e LocalStack (porta 4566), já com as filas criadas
bun run migration:up    # aplica o schema
bun run start           # API em http://localhost:3000 + consumidor SQS + workers
```

O PostgreSQL é exposto na porta **5433** do host, para não colidir com outro Postgres local. Sem `.env`, a aplicação usa os valores do `docker-compose`; veja [.env.example](.env.example) e a seção [Configuração](#configuração).

### Várias instâncias

Cada instância roda todos os papéis: API, consumidor SQS, publisher da outbox e worker de referências pendentes. Para subir 3 réplicas no Docker Compose:

```bash
docker compose --profile app up -d --build --scale app=3
docker compose ps        # mostra a porta do host de cada réplica
```

O serviço `migrate` aplica as migrations uma vez antes das réplicas subirem. Para desligar: `docker compose --profile app down`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | Sobe a aplicação |
| `bun run typecheck` | Checagem de tipos (`tsc`, modo strict) |
| `bun run test` | Todos os testes (unidade, integração e concorrência) |
| `bun run test:unit` | Só testes de unidade (não precisam de Docker) |
| `bun run test:integration` | Integração com PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | Cenários de concorrência, incluindo 3 processos reais da aplicação |
| `bun run test:load` | Teste de carga com 3 instâncias; grava o relatório em [docs/load-test/](docs/load-test/README.md) |
| `bun run migration:up` / `migration:down` | Aplica / reverte as migrations |
| `bun run infra:up` / `infra:down` | Sobe / derruba Postgres e LocalStack (`down` apaga os volumes) |

## Testes

Os testes de integração e de concorrência precisam do `bun run infra:up`. Eles usam um banco separado (`wagering_test`, criado automaticamente) e filas SQS próprias, criadas e removidas por teste, então não interferem no ambiente de desenvolvimento.

Nenhum teste substitui PostgreSQL ou SQS por mocks. Os cenários obrigatórios do §13 do desafio estão em:

| Cenário | Arquivo |
|---|---|
| Mesma aposta 50× em paralelo, cenário 100/80/80, wallets distintas em paralelo | `test/concurrency/in-process-concurrency.test.ts` |
| 3 processos reais, `kill -9` depois do commit e antes do ack, reinício do serviço | `test/concurrency/multi-instance.test.ts` |
| Dois publishers sobre a mesma outbox | `test/integration/outbox-publisher.test.ts` |
| `ROLLBACK`/`REFUND` antes da referência | `test/integration/pending-reference.test.ts` |
| Inbox, redelivery, retry e DLQ | `test/integration/sqs-consumer.test.ts` |
| Migrations e constraints | `test/integration/schema.test.ts` |
| Atomicidade entre wallet, ledger, inbox e outbox | `test/integration/process-wager-transaction.test.ts` |

Os cenários que movimentam saldo terminam verificando a invariante `wallet.balance == saldo reconstruído pelo ledger`.

## Uso rápido

Criar uma wallet:

```bash
curl -s -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Submeter uma aposta (troque `<walletId>`). Repetir a mesma requisição devolve a mesma resposta com `"idempotentReplay": true`:

```bash
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"player-1",
       "walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

Enviar a mesma operação pela fila:

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"transaction-456","idempotencyKey":"provider-a:transaction-456",
    "playerId":"player-1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
    "money":{"amount":"25.00","currency":"BRL"}}}'
```

## Endpoints

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | Cria wallet (com transação `OPENING` quando o saldo inicial é maior que zero) |
| `GET /wallets/:walletId` | Saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | Ledger paginado (cursor opaco, `limit` de 1 a 200, padrão 50) |
| `POST /wallets/:walletId/reconciliation` | Compara o saldo armazenado com o reconstruído pelo ledger |
| `POST /wagering/transactions` | Submete uma operação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET /health/live` · `GET /health/ready` | Liveness · readiness (PostgreSQL e SQS) |
| `GET /metrics` | Métricas no formato Prometheus |

Os status HTTP e os códigos de erro estão em [ARCHITECTURE.md › API HTTP](ARCHITECTURE.md#api-http).

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5433/wagering` | PostgreSQL |
| `SQS_ENDPOINT` | `http://localhost:4566` | Endpoint SQS (LocalStack) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `us-east-1`, `test`, `test` | Credenciais aceitas pelo LocalStack |
| `WAGER_TRANSACTIONS_QUEUE`, `WAGER_TRANSACTIONS_DLQ`, `WALLET_EVENTS_QUEUE` | nomes do desafio | Filas de entrada, DLQ e eventos |
| `SQS_WAIT_TIME_SECONDS` | `10` | Long polling do consumidor |
| `SQS_RETRY_BASE_SECONDS`, `SQS_RETRY_MAX_SECONDS` | `2`, `300` | Backoff de erros transitórios na fila |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Tempo máximo para concluir a mensagem em andamento no `SIGTERM` |
| `ENABLE_HTTP`, `ENABLE_SQS_CONSUMER`, `ENABLE_OUTBOX_PUBLISHER`, `ENABLE_PENDING_REFERENCE_WORKER` | `true` | Liga ou desliga cada papel da instância |
| `LOG_LEVEL` | `info` | Nível dos logs JSON |

## Estrutura

```
src/
  domain/          Money, Wallet, WalletLedgerEntry, WagerTransaction, regras (wager-settlement), eventos
  application/     use cases, portas (store, filas, métricas, logs) e contratos de entrada
  infrastructure/  MikroORM, SQS, workers, Prometheus, pino
  interfaces/http/ controllers, validação, mapeamento de erros
test/
  unit/  integration/  concurrency/  helpers/
docs/
  adr/   decisões de arquitetura      plans/ plano de implementação
```

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md): decisões, garantias, trade-offs e limitações
- [docs/adr/](docs/adr/): registros de decisão de arquitetura
- [docs/load-test/](docs/load-test/README.md): metodologia, resultados e análise do teste de carga
- [GLOSSARY.md](GLOSSARY.md): linguagem do domínio
