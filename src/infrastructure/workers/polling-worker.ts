import type { StructuredLogger } from '../../application/ports/observability';

export interface PollingWorkerOptions {
  name: string;
  /** Espera entre ciclos quando não houve trabalho. */
  idleDelayMs: number;
  /** Espera depois de um erro (banco/fila fora do ar). */
  errorDelayMs: number;
}

/**
 * Laço de worker em background: roda `tick` até ser parado. Se o tick encontrou
 * trabalho, roda de novo imediatamente; senão, dorme. stop() espera o tick atual terminar.
 */
export class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly tick: () => Promise<boolean>,
    private readonly options: PollingWorkerOptions,
    private readonly logger: StructuredLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let delay = this.options.idleDelayMs;
      try {
        const didWork = await this.tick();
        if (didWork) delay = 0;
      } catch (error) {
        delay = this.options.errorDelayMs;
        this.logger.warn(
          { worker: this.options.name, err: error instanceof Error ? error.message : String(error) },
          'worker tick failed',
        );
      }
      if (delay > 0 && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = undefined;
      }
    }
  }
}
