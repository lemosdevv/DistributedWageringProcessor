import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

/** Ponto de extensão da autenticação (§2, ADR-0003). Hoje não valida nada. */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
