---
status: accepted
---

# Eventos de integração publicados na fila `wallet-events.fifo`

O desafio exige uma Transactional Outbox e um worker que publique os eventos, mas **não define o destino** da publicação (§11). Por isso, adotamos como interpretação documentada uma fila SQS própria, `wallet-events.fifo`, criada no LocalStack junto com as filas de entrada. O `MessageGroupId` é o `aggregateId`, para preservar a ordem por wallet ou transação, e o `MessageDeduplicationId` é o `eventId`. A deduplicação do broker é só otimização: a garantia final é o `eventId` do envelope, que permite ao consumidor descartar publicações duplicadas. A entrega é at-least-once.

## Considered Options

- **SNS topic**: daria fan-out, mas acrescenta infraestrutura que o desafio não pede.
- **Fila standard**: mais simples, mas perde a ordenação por agregado, útil para quem consome `WalletBalanceChanged`.
