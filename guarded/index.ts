/**
 * In-code kill switches for Durable Objects.
 *
 *   export class Chat extends withGuard(DurableObject, { rowsWrittenPerHour: 100_000, alarmsPerHour: 120 }) { … }
 *   export class Hub extends withGuard(Agent, { rowsWrittenPerHour: 50_000 }) { … }
 *
 * Each object meters its own storage use and alarms. When it goes over its hourly budget it trips:
 * its pending alarm is cancelled, new alarms are refused, and storage calls throw GuardTrippedError,
 * so a runaway loop stops within one iteration. The trip is stored and survives eviction and
 * redeploys until `resetGuard()` is called. Nothing is deleted.
 *
 * Storage is metered in place, so it covers every reference to it, including ones the base class
 * took before the guard ran. Storage used inside the base class's own constructor runs before the
 * guard is installed and is not counted.
 */

export type Budget = {
  rowsReadPerHour?: number;
  rowsWrittenPerHour?: number;
  alarmsPerHour?: number;
};

export type GuardOptions = {
  /** Name of an Analytics Engine binding to report usage and trips to. */
  analytics?: string;
};

export type GuardStatus = {
  hour: string;
  rowsRead: number;
  rowsWritten: number;
  alarms: number;
  tripped: string | null;
  budget: Budget;
};

export class GuardTrippedError extends Error {
  constructor(reason: string) {
    super(`spend guard tripped: ${reason}`);
    this.name = "GuardTrippedError";
  }
}

const STATE_KEY = "__spend_guard";
const HOUR = 3_600_000;
const PERSIST_EVERY_MS = 5_000;
/** Cursors are read for row counts until this many newer ones exist. */
const TRACKED_CURSORS = 32;

type State = { hour: number; rowsRead: number; rowsWritten: number; alarms: number; tripped: string | null };
type Cursor = { rowsRead: number; rowsWritten: number };
/** The storage calls the guard makes for itself, which must not be metered or blocked. */
export type Unmetered = Pick<DurableObjectStorage, "get" | "put" | "deleteAlarm">;

export class Meter {
  state: State = { hour: currentHour(), rowsRead: 0, rowsWritten: 0, alarms: 0, tripped: null };
  private cursors: { cursor: Cursor; read: number; written: number }[] = [];
  private lastPersist = 0;

  constructor(
    private raw: Unmetered,
    readonly budget: Budget,
    private report: (s: State, event: "usage" | "trip") => void = () => {},
  ) {}

  async load() {
    const saved = await this.raw.get<State>(STATE_KEY);
    if (saved) this.state = saved;
    this.rollHour();
  }

  /** Throws if tripped; call before any storage operation. */
  check() {
    this.settle();
    if (this.state.tripped) throw new GuardTrippedError(this.state.tripped);
  }

  track(cursor: Cursor) {
    this.cursors.push({ cursor, read: 0, written: 0 });
    if (this.cursors.length > TRACKED_CURSORS) this.cursors.shift();
    // Writes run when exec is called; reading after the current task catches them without
    // waiting for the next storage call.
    queueMicrotask(() => this.settle());
  }

  count(rowsRead: number, rowsWritten: number) {
    this.rollHour();
    this.state.rowsRead += rowsRead;
    this.state.rowsWritten += rowsWritten;
    this.enforce();
  }

  /** Returns false when the alarm must not be scheduled. */
  alarm(): boolean {
    this.check();
    this.rollHour();
    this.state.alarms += 1;
    this.enforce();
    return !this.state.tripped;
  }

  settle() {
    let read = 0;
    let written = 0;
    for (const c of this.cursors) {
      read += c.cursor.rowsRead - c.read;
      written += c.cursor.rowsWritten - c.written;
      c.read = c.cursor.rowsRead;
      c.written = c.cursor.rowsWritten;
    }
    if (read || written) this.count(read, written);
  }

  reset() {
    this.cursors = [];
    this.state = { hour: currentHour(), rowsRead: 0, rowsWritten: 0, alarms: 0, tripped: null };
    this.persist(true);
  }

  status(): GuardStatus {
    this.settle();
    const { hour, rowsRead, rowsWritten, alarms, tripped } = this.state;
    return { hour: new Date(hour * HOUR).toISOString(), rowsRead, rowsWritten, alarms, tripped, budget: this.budget };
  }

  private enforce() {
    if (this.state.tripped) return;
    const { budget: b, state: s } = this;
    const over =
      (b.rowsWrittenPerHour !== undefined && s.rowsWritten > b.rowsWrittenPerHour && `${s.rowsWritten} rows written this hour, budget ${b.rowsWrittenPerHour}`) ||
      (b.rowsReadPerHour !== undefined && s.rowsRead > b.rowsReadPerHour && `${s.rowsRead} rows read this hour, budget ${b.rowsReadPerHour}`) ||
      (b.alarmsPerHour !== undefined && s.alarms > b.alarmsPerHour && `${s.alarms} alarms this hour, budget ${b.alarmsPerHour}`);
    if (over) {
      s.tripped = over;
      void this.raw.deleteAlarm();
      this.report(s, "trip");
    }
    this.persist(!!s.tripped);
  }

  private rollHour() {
    const hour = currentHour();
    if (hour === this.state.hour) return;
    // A trip stays until reset, even across hours: the loop it stopped would start again.
    this.state = { hour, rowsRead: 0, rowsWritten: 0, alarms: 0, tripped: this.state.tripped };
  }

  private persist(now: boolean) {
    const t = Date.now();
    if (!now && t - this.lastPersist < PERSIST_EVERY_MS) return;
    this.lastPersist = t;
    // Not awaited: the Durable Object output gate holds responses until the write is durable.
    void this.raw.put(STATE_KEY, { ...this.state });
    this.report(this.state, "usage");
  }
}

const currentHour = () => Math.floor(Date.now() / HOUR);

const keyCount = (k: unknown) => (Array.isArray(k) ? k.length : typeof k === "object" && k ? Object.keys(k).length : 1);

type Fn = (...args: any[]) => any;

/**
 * Meters a storage object in place, so every holder of it is covered: the `ctx` your constructor
 * receives, and frameworks like the Agents SDK that keep their own reference to it.
 */
export function meterStorage(storage: DurableObjectStorage, meter: Meter) {
  const orig = <K extends keyof DurableObjectStorage>(k: K) => (storage[k] as Fn).bind(storage);
  const get = orig("get"), put = orig("put"), del = orig("delete"), setAlarm = orig("setAlarm");
  patch(storage, {
    get: (key: unknown, opts?: unknown) => {
      meter.check();
      meter.count(keyCount(key), 0);
      return get(key, opts);
    },
    put: (key: unknown, value?: unknown, opts?: unknown) => {
      meter.check();
      meter.count(0, keyCount(key));
      return put(key, value, opts);
    },
    delete: (key: unknown, opts?: unknown) => {
      meter.check();
      meter.count(0, keyCount(key));
      return del(key, opts);
    },
    setAlarm: (time: number | Date, opts?: DurableObjectSetAlarmOptions) => (meter.alarm() ? setAlarm(time, opts) : Promise.resolve()),
  });
  if (storage.sql) {
    const exec = storage.sql.exec.bind(storage.sql);
    patch(storage.sql, {
      exec: (query: string, ...bindings: unknown[]) => {
        meter.check();
        const cursor = exec(query, ...bindings);
        meter.track(cursor);
        return cursor;
      },
    });
  }
}

/** The original storage calls, captured before metering, for the guard's own bookkeeping. */
export function unmetered(storage: DurableObjectStorage): Unmetered {
  return { get: storage.get.bind(storage), put: storage.put.bind(storage), deleteAlarm: storage.deleteAlarm.bind(storage) } as Unmetered;
}

function patch(target: object, methods: Record<string, Fn>) {
  for (const [name, fn] of Object.entries(methods)) {
    Object.defineProperty(target, name, { value: fn, configurable: true, writable: true });
    if ((target as Record<string, unknown>)[name] !== fn) throw new Error(`spend guard could not meter storage.${name}`);
  }
}

type AnyClass = abstract new (...args: any[]) => object;

export function withGuard<B extends AnyClass>(Base: B, budget: Budget, options: GuardOptions = {}) {
  abstract class Guarded extends Base {
    #meter: Meter;

    constructor(...args: any[]) {
      super(...args);
      const [ctx, env] = args as [DurableObjectState, Record<string, unknown>];
      const analytics = options.analytics ? (env?.[options.analytics] as AnalyticsEngineDataset | undefined) : undefined;
      const name = new.target.name;
      const meter = (this.#meter = new Meter(unmetered(ctx.storage), budget, (s, event) =>
        analytics?.writeDataPoint({
          indexes: [name],
          blobs: [name, ctx.id.toString(), event, s.tripped ?? ""],
          doubles: [s.rowsRead, s.rowsWritten, s.alarms],
        }),
      ));
      meterStorage(ctx.storage, meter);
      void ctx.blockConcurrencyWhile(() => meter.load());
    }

    guardStatus(): GuardStatus {
      return this.#meter.status();
    }

    resetGuard(): GuardStatus {
      this.#meter.reset();
      return this.#meter.status();
    }
  }
  return Guarded;
}
