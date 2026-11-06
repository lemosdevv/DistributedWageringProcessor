# Resultados do teste de carga

> Gerado por `bun run test:load` em 2026-11-06T00:06:22.201Z. Os números dependem da máquina; o objetivo é a metodologia e a verificação de consistência sob carga, não um alvo de RPS.

## Ambiente

| Item | Valor |
|---|---|
| Sistema | win32 10.0.26200 |
| CPU | AMD Ryzen 7 5700 (16 threads lógicas) |
| Memória | 15.9 GiB |
| Runtime | Bun 1.4.4 |
| PostgreSQL | postgres:17-alpine (Docker) |
| SQS | LocalStack 4.9 (Docker) |
| Instâncias da aplicação | 3 processos locais, cada um com API, consumidor, publisher e worker |

Gerador de carga, instâncias e containers rodam **na mesma máquina** e disputam CPU entre si.

## Metodologia

- Banco próprio (`wagering_load`) recriado pelas migrations; filas SQS próprias.
- 50 wallets com saldo de 1.000.000,00 BRL e 1 *hot wallet* com 500,00 BRL.
- **Fase HTTP:** 5000 requisições com 50 clientes concorrentes, distribuídas entre as instâncias. Mix: ~75% BET em wallet aleatória, ~10% WIN, ~10% BET de 10,00 na hot wallet (disputa pelo mesmo lock e rejeições por saldo depois de 50 apostas), ~5% reenvio idêntico (replay).
- **Fase SQS:** 2000 mensagens (BET em wallet aleatória, `MessageGroupId` = wallet), mais ~10% reentregues com o mesmo `messageId`. A latência é medida do envio até o `created_at` da transação no banco.
- **Outbox:** lag por evento = `published_at - occurred_at`, calculado no banco para todos os eventos.
- Latência HTTP medida no cliente (inclui rede local e serialização).

## Resultados

### HTTP

| Métrica | Valor |
|---|---|
| Requisições | 5000 em 9.9 s |
| Throughput | **505.1 req/s** |
| Latência p50 / p95 / p99 | 77.9 ms / 250.6 ms / 356.7 ms (máx. 886.1 ms) |
| Status | 200: 4536 · 422: 464 |
| Taxa de erro (5xx + falhas de rede) | **0.00%** (0) |

Os 422 são rejeições de negócio esperadas (saldo insuficiente na hot wallet), não erros.

### SQS

| Métrica | Valor |
|---|---|
| Mensagens | 2191 enviadas (2000 operações distintas) em 18.5 s |
| Throughput | **108.1 operações/s** |
| Latência envio → commit p50 / p95 / p99 | 8074.0 ms / 14967.0 ms / 15932.0 ms (máx. 16181.0 ms) |
| Mensagens na DLQ | 0 |

### Concorrência e duplicatas

| Métrica | Valor |
|---|---|
| Conflitos de concorrência (retries por corrida) | 0 |
| Retries (todas as operações) | 0 |
| Espera média pelo lock da wallet | 18.2 ms em 6761 aquisições |
| Replays idempotentes detectados | 247 |
| Reentregas barradas pela inbox | 191 |

### Outbox

| Métrica | Valor |
|---|---|
| Eventos publicados | 13161 |
| Lag p50 / p95 / p99 | 24274.0 ms / 29543.0 ms / 30061.0 ms (máx. 30249.0 ms) |
| Tempo para drenar após o fim da carga | 22.2 s |

### Consistência final

| Verificação | Resultado |
|---|---|
| Wallets com saldo ≠ ledger | **0** de 51 |
| Wallets com saldo negativo | **0** |
| Operações do provedor duplicadas | **0** |
| Reconciliação da hot wallet | consistent: true, saldo 0.00 |

Transações por status:

| Status | failureCode | Quantidade |
|---|---|---|
| PROCESSED | — | 6306 |
| REJECTED | INSUFFICIENT_FUNDS | 447 |
