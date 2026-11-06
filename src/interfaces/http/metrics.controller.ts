import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WAGERING_METRICS } from '../../application/ports/metrics';
import type { PrometheusWageringMetrics } from '../../infrastructure/observability/prometheus-metrics';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(WAGERING_METRICS) private readonly metrics: PrometheusWageringMetrics) {}

  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('content-type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}
