/** A video or audio preview hands the desktop player a path it can open, and the web the loaded bytes. */
import { expect, test } from "nsh/test";
import { localFilePath, mediaFilePath, mediaSource } from "./media-source";

const base = { web: false, local: true, workspaceRoot: "/Users/me/ws", blobUrl: "blob:nsh/1" };

test("a workspace file on a desktop plays from its path under the workspace", () => {
  expect(mediaSource({ ...base, relpath: "work/job/launch/film.mp4" })).toBe("/Users/me/ws/work/job/launch/film.mp4");
});

test("a project session's file is already absolute and plays from where it is", () => {
  expect(mediaSource({ ...base, relpath: "/Users/me/site/media/film.mp4" })).toBe("/Users/me/site/media/film.mp4");
});

test("the web and a remote runtime keep the loaded bytes", () => {
  expect(mediaSource({ ...base, web: true, relpath: "a.mp4" })).toBe("blob:nsh/1");
  expect(mediaSource({ ...base, local: false, relpath: "a.mp4" })).toBe("blob:nsh/1");
});

test("a path under the home keeps the loaded bytes: the home is the runtime's to know", () => {
  expect(mediaSource({ ...base, relpath: "~/Movies/a.mp4" })).toBe("blob:nsh/1");
});

test("with no workspace to put a relative path under, the bytes are what there is", () => {
  expect(mediaSource({ ...base, workspaceRoot: null, relpath: "a.mp4" })).toBe("blob:nsh/1");
  expect(mediaSource({ ...base, workspaceRoot: null, relpath: "a.mp4", blobUrl: null })).toBe("");
});

test("Windows roots join with their own separator", () => {
  expect(localFilePath("work\\a.mp4", "C:\\Users\\me\\ws\\")).toBe("C:\\Users\\me\\ws\\work\\a.mp4");
  expect(localFilePath("work/a.mp4", "C:\\Users\\me\\ws")).toBe("C:\\Users\\me\\ws\\work\\a.mp4");
  expect(localFilePath("D:\\clips\\a.mp4", "C:\\ws")).toBe("D:\\clips\\a.mp4");
});

test("the file the loader leaves unread is the one the player opens; the rest are read", () => {
  const where = { web: false, local: true, workspaceRoot: "/Users/me/ws" };
  expect(mediaFilePath({ ...where, relpath: "work/edit/master.mp4" })).toBe("/Users/me/ws/work/edit/master.mp4");
  expect(mediaFilePath({ ...where, relpath: "/Users/me/site/a.mp4" })).toBe("/Users/me/site/a.mp4");
  expect(mediaFilePath({ ...where, web: true, relpath: "a.mp4" })).toBeNull();
  expect(mediaFilePath({ ...where, local: false, relpath: "a.mp4" })).toBeNull();
  expect(mediaFilePath({ ...where, relpath: "~/Movies/a.mp4" })).toBeNull();
  expect(mediaFilePath({ ...where, workspaceRoot: null, relpath: "a.mp4" })).toBeNull();
  for (const relpath of ["work/edit/master.mp4", "/Users/me/site/a.mp4", "~/a.mp4"]) {
    const path = mediaFilePath({ ...where, relpath });
    expect(mediaSource({ ...where, relpath, blobUrl: "blob:nsh/1" })).toBe(path ?? "blob:nsh/1");
  }
});
