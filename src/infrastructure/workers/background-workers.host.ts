import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { StructuredLogger } from '../../application/ports/observability';
import type { PollingWorker } from './polling-worker';

/** Inicia os workers habilitados nesta instância e os para no shutdown, esperando o ciclo atual. */
export class BackgroundWorkersHost implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    private readonly workers: readonly { name: string; worker: PollingWorker }[],
    private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    for (const { name, worker } of this.workers) {
      worker.start();
      this.logger.info({ worker: name }, 'background worker started');
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map(({ worker }) => worker.stop()));
  }
}
