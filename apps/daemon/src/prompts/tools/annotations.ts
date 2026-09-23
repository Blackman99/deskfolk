import { type ToolDef } from "../tool-schema";
import { PATH_DESC } from "./files";

export const LIST_ANNOTATIONS: ToolDef = {
  name: "list_annotations",
  description: {
    zh: "查用户在产物上写的批注。批注是用户对某个文件某一处的一句意见，挂在交出这个文件的那条消息上；带批注的消息会在正文后面逐条展开，这个工具用来在后续任务里查还没处理完的。默认列出这件事（当前工作目录、这个会话）里所有待处理的批注；给了 path 就只看这个文件，路径和 read_file 一样解析，工作区外的路径会报错；status 可以换成 resolved 或 all。返回每条的 id、for_bot（交给了哪个 Bot）、路径、位置摘要、意见、状态、是否陈旧（原文已变 / 文件不在了）、谁处理的和处理说明。交给你的由你处理；交给别的 Bot 的留给它，可以提一句；交给已删除的 Bot 的归叫醒你的那批由你处理。",
    en: "List the annotations the user wrote on artifacts. An annotation is one remark on one spot of a file, hung on the message that delivered it; a message that carries annotations spells them out under its body, and this tool finds the ones still pending in later work. By default it lists every pending annotation for this job (the current work dir, this session); pass path to see one file, resolved the way read_file resolves it (a path outside the workspace is an error); status may be resolved or all. Returns each one's id, for_bot (the Bot it was handed to), path, position summary, remark, status, whether it is stale (the text moved or the file is gone), who resolved it, and the note. Handle the ones for you; leave the ones for another Bot to that Bot (you may mention them); the ones for a deleted Bot are yours when their batch woke you.",
  },
  properties: {
    path: { type: "string", description: PATH_DESC },
    status: {
      type: "string",
      enum: ["open", "resolved", "all"],
      description: { zh: "默认 open：只看待处理的。", en: "Defaults to open: pending ones only." },
    },
  },
};

export const RESOLVE_ANNOTATION: ToolDef = {
  name: "resolve_annotation",
  description: {
    zh: "把一条待处理的批注标成已处理，note 必填：写一句你改了什么。只标交给你的批注（交给已删除的 Bot 的也算你的）；交给别的 Bot 的留给它，可以在回复里提一句。只在真的改了之后才标；不同意或做不到的，在回复里说明原因，不要标。不能重新打开、不能删、不能新建批注。不要为这次标记再发一条聊天消息。",
    en: "Mark one pending annotation as resolved; note is required: one sentence on what you changed. Mark only the ones handed to you (a deleted Bot's count as yours); leave another Bot's to that Bot (you may mention them in your reply). Mark it only after you actually changed it; when you disagree or cannot, explain in your reply and leave it pending. You cannot reopen, delete, or create annotations. Do not send a chat message about this mark.",
  },
  properties: {
    id: { type: "string", description: { zh: "批注 id，来自消息里的 `id=` 或 list_annotations。", en: "The annotation id, from the message's `id=` or list_annotations." } },
    note: { type: "string", description: { zh: "怎么改的，一句话。", en: "What changed, in one sentence." } },
  },
  required: ["id", "note"],
};
