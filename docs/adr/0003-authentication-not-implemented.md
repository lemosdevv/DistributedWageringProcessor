---
status: accepted
---

# Autenticação não implementada, com ponto de extensão explícito

A autenticação não vale pontos na avaliação (§2, §14), e o desafio aceita explicitamente não implementá-la, desde que a decisão seja documentada e o ponto de extensão fique visível no código. Por isso **não implementamos**: existe um `AuthGuard` no-op aplicado aos endpoints de negócio. Os health checks ficam fora dele, e mensagens da fila são tratadas como canal interno confiável. A identidade do provedor contida em cada transação continua sujeita às validações de domínio. O desenho adotado, caso seja implementado, está descrito no `ARCHITECTURE.md`: Keycloak no Docker Compose, client credentials por provedor e a claim do provedor comparada com o `providerId` do payload.

## Considered Options

- **Keycloak ou Zitadel integrados agora**: rejeitado para não competir em tempo com correção financeira, concorrência e idempotência, que valem pontos.
- **Autenticação artesanal** (tabela de usuários com hash de senha): proibida pelo §2.
