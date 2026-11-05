---
status: accepted
---

# MikroORM com EntitySchema na infraestrutura

O desafio aceita MikroORM (preferencial) ou TypeORM e exige que o domínio não dependa de tipos do ORM nem de decorators. Escolhemos **MikroORM**, porque o Unit of Work, o `em.transactional()` e o `LockMode` explícitos casam com a exigência de que inbox, transação, wallet, ledger e outbox participem da mesma transação SQL. O mapeamento é feito com `EntitySchema` em `src/infrastructure/persistence/`, sobre registros de persistência, e mappers convertem para o domínio via `rehydrate`. Assim as classes de domínio ficam livres de decorators e o `Money` é persistido como `NUMERIC` + moeda e lido sempre como string.

## Considered Options

- **TypeORM**: aceito pelo desafio, mas o controle de Unit of Work e de transação é menos explícito.
- **Decorators do MikroORM nas entidades de domínio**: rejeitado, porque viola a regra de o domínio não depender do ORM.
