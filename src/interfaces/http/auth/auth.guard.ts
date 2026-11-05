import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação (§2, ADR-0003). Hoje não valida nada.
 * Desenho previsto: validar o JWT do IdP (Keycloak, client credentials por provider)
 * e comparar a claim do provider com o providerId do payload.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
