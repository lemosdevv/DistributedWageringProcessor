import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ReadinessChecker, type ReadinessReport } from '../../infrastructure/observability/readiness';

/** Health checks abertos, sem autenticação (§9). */
@Controller('health')
export class HealthController {
  constructor(@Inject(ReadinessChecker) private readonly readiness: ReadinessChecker) {}

  /** Processo vivo: não consulta dependências, para o orquestrador não reiniciar por falha externa. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
