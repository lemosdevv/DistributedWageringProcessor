# Teste de carga

```bash
bun run infra:up
bun run test:load
```

O script ([scripts/load-test.ts](../../scripts/load-test.ts)) sobe 3 processos reais da aplicação contra um banco próprio (`wagering_load`) e filas SQS próprias. Ele gera carga por HTTP e por SQS, mede os resultados e, no fim, **falha se alguma invariante for violada**: saldo diferente do ledger, saldo negativo ou operação do provedor duplicada. O relatório completo da última execução é gravado em [results.md](results.md).

Parâmetros (variáveis de ambiente): `LOAD_INSTANCES` (3), `LOAD_HTTP_REQUESTS` (5000), `LOAD_CONCURRENCY` (50), `LOAD_SQS_MESSAGES` (2000), `LOAD_WALLETS` (50).

## Ambiente e metodologia

**Ambiente:** Windows 11, AMD Ryzen 7 5700 (16 threads), 15,9 GiB de RAM, Bun 1.4.4, PostgreSQL 17 e LocalStack 4.9 no Docker Desktop. Gerador de carga, as 3 instâncias e os containers rodam **na mesma máquina**, disputando CPU.

**Carga:**
- 50 wallets com saldo alto e 1 *hot wallet* com 500,00.
- **HTTP:** 5.000 requisições, com 50 clientes concorrentes distribuídos entre as instâncias. Mix: ~75% BET em wallet aleatória, ~10% WIN, ~10% BET de 10,00 na hot wallet e ~5% replays.
- **SQS:** 2.000 operações enviadas de uma vez (com `MessageGroupId` = wallet), mais ~10% reentregues com o mesmo `messageId`.

**Como cada número é medido:**
- **Latência HTTP:** no cliente.
- **Latência SQS:** do envio até o `created_at` da transação no banco. Inclui o tempo de enfileirar o lote inteiro.
- **Outbox lag:** `published_at − occurred_at` de cada evento, calculado no banco.

## Resultados: antes e depois das melhorias de vazão

A primeira execução expôs dois gargalos (análise abaixo). A segunda roda com as duas correções:
- **Outbox:** publicação com `SendMessageBatch`, em lotes de 10, com claim de até 100 eventos.
- **Consumidor:** processa em paralelo as mensagens de grupos FIFO diferentes do mesmo lote.

| Métrica | 1ª execução | 2ª execução |
|---|---|---|
| Throughput HTTP | 505 req/s | 476 req/s |
| Latência HTTP p50 / p95 / p99 | 77,9 / 250,6 / 356,7 ms | 85,6 / 260,2 / 378,3 ms |
| Taxa de erro HTTP (5xx + rede) | **0,00%** | **0,00%** |
| Throughput SQS | 108 operações/s | **142 operações/s** |
| Latência SQS envio → commit p50 / p95 / p99 | 8,1 / 15,0 / 15,9 s | 5,7 / 11,5 / 12,1 s |
| Mensagens na DLQ | 0 | 0 |
| Conflitos de concorrência (retries por corrida) | 0 | 0 |
| Espera média pelo lock da wallet | 18,2 ms | 18,4 ms |
| Replays detectados / reentregas barradas pela inbox | 247 / 191 | 271 / 223 |
| **Outbox lag p50 / p95 / p99** | 24.274 / 29.543 / 30.061 ms | **142 / 382 / 555 ms** |
| Tempo para drenar a outbox depois da carga | 22,2 s | **0 s** |
| Wallets com saldo ≠ ledger · saldo negativo · operações duplicadas | **0 · 0 · 0** | **0 · 0 · 0** |
| Hot wallet | 50 apostas aceitas, saldo 0,00, reconciliação consistente | idem |

Os 422 HTTP são rejeições de negócio esperadas (saldo insuficiente na hot wallet, mais os replays delas), não erros.

## Análise

**Correção sob carga.** Nas duas execuções, nenhuma invariante foi violada. Os reenvios HTTP viraram replays, as reentregas SQS foram barradas pela inbox, e a hot wallet aceitou exatamente as 50 apostas que cabiam no saldo. A métrica de conflitos ficou em zero porque o lock pessimista serializa a disputa **antes** da escrita: a contenção aparece como espera pelo lock (~18 ms em média), não como retry.

**HTTP.** O caminho síncrono sustentou ~480–500 req/s com p99 abaixo de 400 ms e 0% de erro. A variação entre as execuções (505 → 476 req/s) está dentro do ruído de uma máquina compartilhada entre gerador, aplicação e containers; as mudanças não tocaram o caminho HTTP.

**Outbox: gargalo resolvido.** Na 1ª execução, cada evento saía num `SendMessage` individual, e a carga gerava eventos (2 por transação aplicada) mais rápido do que os publishers publicavam. O backlog fez o lag chegar a ~24 s. Com `SendMessageBatch`, cada chamada ao broker leva 10 eventos: o lag p99 caiu para ~0,5 s e a outbox drena durante a própria carga. As garantias não mudaram: o evento só sai depois do commit, só é marcado depois de o broker aceitar, e uma falha parcial do lote reenvia só os eventos recusados. Os lotes saem em sequência para manter a ordem por agregado; há teste para isso.

**SQS: melhora parcial, com o próximo gargalo identificado.** Processar grupos diferentes em paralelo aumentou a vazão em ~31%, mas a latência continua em segundos. Dois fatores explicam:

1. **A medida inclui o tempo de enfileirar as ~2.200 mensagens** de uma vez, então parte da latência é a fila crescendo, não o processamento.
2. **Cada mensagem ainda gera chamadas individuais ao broker**, como o `DeleteMessage` depois do commit. Com o LocalStack na mesma máquina, essas chamadas ficaram mais caras que o próprio processamento.

O próximo passo seria confirmar as mensagens com `DeleteMessageBatch` ao fim de cada lote, mantendo o ack só depois do commit de cada uma.

**Limites do experimento.**
- Cada configuração foi executada uma única vez, numa única máquina.
- O LocalStack emula o SQS, com latência e limites diferentes da AWS.
- Não houve aquecimento separado da medição.
- Os percentis HTTP são medidos no cliente e incluem a rede local do Docker Desktop.

Os resultados servem para comparar mudanças nesta mesma configuração, como a comparação acima, e não para estimar capacidade de produção.
