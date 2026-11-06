# Teste de carga

```bash
bun run infra:up
bun run test:load
```

O script ([scripts/load-test.ts](../../scripts/load-test.ts)) sobe 3 processos reais da aplicação contra um banco próprio (`wagering_load`) e filas SQS próprias. Ele gera carga por HTTP e por SQS, mede os resultados e, no fim, **falha se alguma invariante for violada**: saldo diferente do ledger, saldo negativo ou operação do provedor duplicada. O relatório completo de cada execução é gravado em [results.md](results.md).

Parâmetros (variáveis de ambiente): `LOAD_INSTANCES` (3), `LOAD_HTTP_REQUESTS` (5000), `LOAD_CONCURRENCY` (50), `LOAD_SQS_MESSAGES` (2000), `LOAD_WALLETS` (50).

## Execução registrada (2026-11-06)

**Ambiente:** Windows 11, AMD Ryzen 7 5700 (16 threads), 15,9 GiB de RAM, Bun 1.4.4, PostgreSQL 17 e LocalStack 4.9 no Docker Desktop. Gerador de carga, as 3 instâncias e os containers rodam **na mesma máquina**, disputando CPU.

**Carga:**
- 50 wallets com saldo alto e 1 *hot wallet* com 500,00.
- **HTTP:** 5.000 requisições, com 50 clientes concorrentes. Mix: ~75% BET em wallet aleatória, ~10% WIN, ~10% BET na hot wallet e ~5% replays.
- **SQS:** 2.000 operações enviadas de uma vez (2.191 mensagens, com ~10% reentregues com o mesmo `messageId`).

| Métrica | Resultado |
|---|---|
| Throughput HTTP | **505 req/s** |
| Latência HTTP p50 / p95 / p99 | 77,9 / 250,6 / 356,7 ms (máx. 886 ms) |
| Taxa de erro HTTP (5xx + rede) | **0,00%**. Os 464 status 422 são rejeições de negócio esperadas na hot wallet (447 transações, mais replays delas) |
| Throughput SQS | 108 operações/s |
| Latência SQS envio → commit p50 / p95 / p99 | 8,1 / 15,0 / 15,9 s |
| Mensagens na DLQ | 0 |
| Conflitos de concorrência (retries por corrida) | 0 |
| Espera média pelo lock da wallet | 18,2 ms (6.761 aquisições) |
| Replays detectados / reentregas barradas pela inbox | 247 / 191 |
| Outbox lag p50 / p95 / p99 | 24,3 / 29,5 / 30,1 s (13.161 eventos) |
| Tempo para drenar a outbox depois da carga | 22,2 s |
| Wallets com saldo ≠ ledger · saldo negativo · operações duplicadas | **0 · 0 · 0** |
| Hot wallet | 50 apostas aceitas (saldo 0,00), o restante rejeitado com `INSUFFICIENT_FUNDS`; reconciliação `consistent: true` |

## Análise

**Correção sob carga.** Nenhuma invariante foi violada. Os 5% de reenvios HTTP viraram replays (247 detectados) e as 191 reentregas SQS foram barradas pela inbox, sem efeito duplicado. A hot wallet aceitou exatamente as 50 apostas que cabiam no saldo. A métrica de conflitos ficou em zero porque o lock pessimista serializa a disputa **antes** da escrita: a contenção aparece como espera pelo lock (média de 18 ms), não como retry.

**HTTP.** Com 3 instâncias na mesma máquina do gerador, o caminho síncrono sustentou ~500 req/s com p99 abaixo de 400 ms. A cauda (máx. 886 ms) coincide com a disputa na hot wallet e com a competição por CPU entre processos e containers. O número é desta máquina, não uma capacidade do serviço.

**SQS: o primeiro gargalo.** As 2.000 operações foram enviadas de uma vez, então a latência de 8 a 16 s é **tempo de fila**, não de processamento. A vazão de ~108 operações/s vem de o consumidor processar o lote **sequencialmente**: cada instância tem uma mensagem em andamento por vez, uma escolha conservadora para preservar a ordem do grupo FIFO. Processar em paralelo as mensagens de **grupos diferentes** dentro do lote aumentaria a vazão sem perder a ordem por wallet.

**Outbox: o segundo gargalo.** O lag de ~24 s (p50) é backlog. Durante a fase HTTP, a carga gerou eventos (2 por transação aplicada) mais rápido do que os publishers conseguiam publicar, porque cada evento é enviado com um `SendMessage` individual e em sequência. O backlog foi drenado 22 s depois do fim da carga, sem perda e sem DLQ. Com `SendMessageBatch` (10 eventos por chamada) e publicação concorrente entre agregados, a publicação deve acelerar na mesma proporção. A garantia não muda: o evento só sai depois do commit e só é marcado depois de o broker aceitar.

**Limites do experimento.** É uma execução única, numa única máquina, com o LocalStack emulando o SQS (latência e limites diferentes da AWS). Não houve aquecimento separado da medição. Os percentis HTTP são medidos no cliente e incluem a rede local do Docker Desktop. Os resultados servem para comparar mudanças nesta mesma configuração, não para estimar capacidade de produção.
