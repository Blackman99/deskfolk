/**
 * What a story reads files dropped from Finder with, in place of the disk (`ReadUris`): each URL is
 * a two-byte text file of its name, and one ending in `/` a folder, which is left out as the real
 * reader leaves folders out.
 */
import type { ReadUris } from "../src/ui/chat/composer-drop";

export const fakeReadFiles: ReadUris = async (uris) => {
  const read = { files: [] as File[], folders: [] as string[], tooLarge: [] as string[], unreadable: [] as string[] };
  for (const uri of uris) {
    const name = decodeURIComponent(uri.replace(/\/+$/, "").split("/").pop() ?? "file");
    if (uri.endsWith("/")) read.folders.push(name);
    else read.files.push(new File([new Uint8Array([104, 105])], name, { type: "text/plain" }));
  }
  return read;
};
