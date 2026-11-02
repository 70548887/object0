import { expect, test } from "bun:test";
import {
  droppedFileEntries,
  isFileDropPointInside,
  physicalDropPoint,
} from "../src/mainview/components/objects/file-drop";

test("desktop drop paths retain original spelling and Unicode while producing object basenames", () => {
  const entries = droppedFileEntries([
    "C:\\Users\\fixture\\Desktop\\中文 +%.txt",
    "D:/data/second.bin",
    "/tmp/third.txt",
  ]);
  expect(entries).toEqual([
    { path: "C:\\Users\\fixture\\Desktop\\中文 +%.txt", name: "中文 +%.txt" },
    { path: "D:/data/second.bin", name: "second.bin" },
    { path: "/tmp/third.txt", name: "third.txt" },
  ]);
});

test("duplicate path notifications produce one entry; conflicting basenames never silently overwrite", () => {
  expect(
    droppedFileEntries(["C:\\fixture\\one.txt", "C:\\fixture\\one.txt"]),
  ).toEqual([{ path: "C:\\fixture\\one.txt", name: "one.txt" }]);
  expect(() =>
    droppedFileEntries(["C:\\first\\one.txt", "D:\\other\\one.txt"]),
  ).toThrow();
  expect(() => droppedFileEntries([])).toThrow();
});

test("POSIX backslashes are literal filename characters, while UNC uses Windows separators", () => {
  expect(droppedFileEntries(["/tmp/a\\b.txt"])).toEqual([
    { path: "/tmp/a\\b.txt", name: "a\\b.txt" },
  ]);
  expect(droppedFileEntries(["\\\\server\\share\\file.txt"])).toEqual([
    { path: "\\\\server\\share\\file.txt", name: "file.txt" },
  ]);
});

test("invalid drop paths do not become invented local files or alternate object keys", () => {
  for (const path of [
    "",
    "one.txt",
    "C:relative.txt",
    "C:\\fixture\\",
    "/tmp/",
    "C:\\fixture\\..",
    "C:\\fixture\\bad\u0000.txt",
  ]) {
    expect(() => droppedFileEntries([path])).toThrow();
  }
});

test("physical pointer coordinates are mapped to CSS coordinates without guessing invalid DPI", () => {
  expect(physicalDropPoint({ x: 480, y: 300 }, 2)).toEqual({ x: 240, y: 150 });
  expect(physicalDropPoint({ x: 480, y: 300 }, 1.5)).toEqual({
    x: 320,
    y: 200,
  });
  for (const scale of [0, -1, NaN, Infinity])
    expect(physicalDropPoint({ x: 1, y: 2 }, scale)).toBeNull();
  for (const position of [
    { x: NaN, y: 1 },
    { x: 1, y: Infinity },
  ])
    expect(physicalDropPoint(position, 1)).toBeNull();
});

test("drop hit-testing excludes sidebar, empty bounds, obscured surfaces and open modals", () => {
  let inert = false;
  let width = 800;
  let topmost = true;
  let modalOpen = false;
  let modalClosed = false;
  const target = {};
  const modal = {
    hasAttribute: (name: string) => name === "data-closed" && modalClosed,
    getClientRects: () => [1],
  };
  const zone = {
    closest: () => (inert ? {} : null),
    getBoundingClientRect: () => ({
      left: 100,
      top: 100,
      right: 900,
      bottom: 700,
      width,
      height: 600,
    }),
    contains: (node: unknown) => node === target,
  } as unknown as HTMLElement;
  const doc = {
    querySelectorAll: () => (modalOpen ? [modal] : []),
    elementFromPoint: () => (topmost ? target : {}),
  } as unknown as Document;
  expect(isFileDropPointInside(zone, { x: 200, y: 200 }, doc)).toBe(true);
  for (const point of [
    { x: 99, y: 200 },
    { x: 900, y: 200 },
    { x: 200, y: 99 },
    { x: 200, y: 700 },
  ])
    expect(isFileDropPointInside(zone, point, doc)).toBe(false);
  expect(isFileDropPointInside(null, { x: 200, y: 200 }, doc)).toBe(false);
  expect(isFileDropPointInside(zone, null, doc)).toBe(false);
  inert = true;
  expect(isFileDropPointInside(zone, { x: 200, y: 200 }, doc)).toBe(false);
  inert = false;
  width = 0;
  expect(isFileDropPointInside(zone, { x: 200, y: 200 }, doc)).toBe(false);
  width = 800;
  topmost = false;
  expect(isFileDropPointInside(zone, { x: 200, y: 200 }, doc)).toBe(false);
  topmost = true;
  modalOpen = true;
  expect(isFileDropPointInside(zone, { x: 200, y: 200 }, doc)).toBe(false);
  modalClosed = true;
  expect(isFileDropPointInside(zone, { x: 200, y: 200 }, doc)).toBe(true);
});
