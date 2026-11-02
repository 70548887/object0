import { expect, test } from "bun:test";
import {
  listenNativeFileDrop,
  type NativeFileDrop,
} from "../src/mainview/components/objects/native-file-drop";

type Source = Parameters<typeof listenNativeFileDrop>[0];
type Row = {
  name: string;
  callback: (event: {
    payload: { paths: string[]; position: { x: number; y: number } };
  }) => void;
  active: boolean;
};
const payload = {
  paths: ["C:\\fixture\\file.txt"],
  position: { x: 40, y: 80 },
};

test("native registration is atomic and every owned listener is removed", async () => {
  const rows: Row[] = [];
  const events: NativeFileDrop[] = [];
  const source = {
    listen: async (name: string, callback: Row["callback"]) => {
      const row = { name, callback, active: true };
      rows.push(row);
      callback({ payload }); // A partial subscription is not yet a valid gesture.
      return () => {
        row.active = false;
      };
    },
  } as unknown as Source;
  const subscription = listenNativeFileDrop(source, (event) =>
    events.push(event),
  );
  await subscription.ready;
  expect(events).toEqual([]);
  expect(rows.map((row) => row.name)).toEqual([
    "tauri://drag-enter",
    "tauri://drag-over",
    "tauri://drag-drop",
    "tauri://drag-leave",
  ]);
  for (const row of rows) row.callback({ payload });
  expect(events.map((event) => event.type)).toEqual([
    "enter",
    "over",
    "drop",
    "leave",
  ]);
  expect(events[0]).toEqual({ type: "enter", ...payload });
  subscription.stop();
  subscription.stop();
  expect(rows.every((row) => !row.active)).toBe(true);
  for (const row of rows) row.callback({ payload });
  expect(events).toHaveLength(4);
});

test("failure in any registration rolls back earlier listeners and invalidates stale callbacks", async () => {
  for (let failAt = 1; failAt <= 4; failAt++) {
    const rows: Row[] = [];
    const events: NativeFileDrop[] = [];
    let attempts = 0;
    const source = {
      listen: async (name: string, callback: Row["callback"]) => {
        attempts++;
        if (attempts === failAt) throw new Error("fixture registration failed");
        const row = { name, callback, active: true };
        rows.push(row);
        return () => {
          row.active = false;
        };
      },
    } as unknown as Source;
    const subscription = listenNativeFileDrop(source, (event) =>
      events.push(event),
    );
    await expect(subscription.ready).rejects.toThrow(
      "fixture registration failed",
    );
    expect(attempts).toBe(failAt);
    expect(rows.every((row) => !row.active)).toBe(true);
    for (const row of rows) row.callback({ payload });
    expect(events).toEqual([]);
    subscription.stop();
  }
});

test("unmount before registration resolves immediately removes the late listener without installing others", async () => {
  let resolve!: (stop: () => void) => void;
  let attempts = 0;
  let stopped = 0;
  const source = {
    listen: () => {
      attempts++;
      return new Promise<() => void>((done) => {
        resolve = done;
      });
    },
  } as unknown as Source;
  const subscription = listenNativeFileDrop(source, () => {
    throw new Error("unexpected callback");
  });
  subscription.stop();
  resolve(() => {
    stopped++;
  });
  await subscription.ready;
  expect(attempts).toBe(1);
  expect(stopped).toBe(1);
});

test("one failing unlisten cannot prevent the other listener cleanup", async () => {
  let attempts = 0;
  let cleaned = 0;
  const source = {
    listen: async () => {
      const index = attempts++;
      return () => {
        cleaned++;
        if (index === 0) throw new Error("fixture cleanup failed");
      };
    },
  } as unknown as Source;
  const subscription = listenNativeFileDrop(source, () => {});
  await subscription.ready;
  expect(() => subscription.stop()).not.toThrow();
  expect(cleaned).toBe(4);
});
