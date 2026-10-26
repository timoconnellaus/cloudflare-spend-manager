import { describe, expect, it, vi } from "vitest";
import { GuardTrippedError, Meter, type Unmetered } from "../guarded/index";

function fakeStorage() {
  const data = new Map<string, unknown>();
  const storage = {
    get: vi.fn(async (k: string) => data.get(k)),
    put: vi.fn(async (k: string, v: unknown) => void data.set(k, v)),
    deleteAlarm: vi.fn(async () => {}),
  };
  return { storage, data, unmetered: storage as unknown as Unmetered };
}

describe("Meter", () => {
  it("trips on the alarm budget, cancels the pending alarm and refuses new ones", () => {
    const { storage, unmetered } = fakeStorage();
    const meter = new Meter(unmetered, { alarmsPerHour: 3 });
    expect([meter.alarm(), meter.alarm(), meter.alarm()]).toEqual([true, true, true]);
    expect(meter.alarm()).toBe(false);
    expect(meter.status().tripped).toMatch(/4 alarms this hour, budget 3/);
    expect(storage.deleteAlarm).toHaveBeenCalledOnce();
    expect(() => meter.alarm()).toThrow(GuardTrippedError);
  });

  it("reads row counts from cursors, including rows a cursor reads after it is returned", () => {
    const { unmetered } = fakeStorage();
    const meter = new Meter(unmetered, { rowsReadPerHour: 100 });
    const cursor = { rowsRead: 10, rowsWritten: 2 };
    meter.track(cursor);
    meter.settle();
    cursor.rowsRead = 90;
    expect(meter.status()).toMatchObject({ rowsRead: 90, rowsWritten: 2, tripped: null });
    cursor.rowsRead = 101;
    expect(() => meter.check()).toThrow(/101 rows read this hour, budget 100/);
  });

  it("keeps a trip across the hour boundary and through a reload, until reset", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-26T10:59:00Z") });
    const { data, unmetered } = fakeStorage();
    const meter = new Meter(unmetered, { rowsWrittenPerHour: 5 });
    meter.count(0, 6);
    vi.setSystemTime(new Date("2026-10-26T11:01:00Z"));
    const reloaded = new Meter(unmetered, { rowsWrittenPerHour: 5 });
    await reloaded.load();
    expect(reloaded.status()).toMatchObject({ rowsWritten: 0, tripped: expect.stringMatching(/6 rows written/) });
    expect(() => reloaded.check()).toThrow(GuardTrippedError);
    reloaded.reset();
    expect(() => reloaded.check()).not.toThrow();
    expect((data.values().next().value as { tripped: unknown }).tripped).toBeNull();
    vi.useRealTimers();
  });

  it("starts a fresh count each hour", () => {
    vi.useFakeTimers({ now: new Date("2026-10-26T10:59:00Z") });
    const { unmetered } = fakeStorage();
    const meter = new Meter(unmetered, { rowsWrittenPerHour: 10 });
    meter.count(0, 8);
    vi.setSystemTime(new Date("2026-10-26T11:00:01Z"));
    meter.count(0, 8);
    expect(meter.status()).toMatchObject({ rowsWritten: 8, tripped: null });
    vi.useRealTimers();
  });
});
