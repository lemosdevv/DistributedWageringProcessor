export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');

export const systemClock: Clock = { now: () => new Date() };

/** UUID v7: ordenável no tempo, o que mantém índices e cursores estáveis. */
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
