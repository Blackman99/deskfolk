/**
 * 批注的本机接口调用，本机与远控两个客户端共用：列、建草稿、改、整批发送。删除和裁图字节各客户端自己
 * 走（一个是 DELETE，一个是文件流）。
 */
import type {
  Annotation,
  AnnotationFilter,
  CreateAnnotationRequest,
  ListPage,
  Message,
  PatchAnnotationRequest,
  SendAnnotationsRequest,
} from "@real-bot/protocol";

export type AnnotationHttp = {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
};

export type SendAnnotationsResult = { message: Message; annotations: Annotation[] };

/** `GET /v1/annotations?…` with only the filters that are set, keys the daemon knows. */
export function annotationsPath(filter: AnnotationFilter & { target_session_id?: string } = {}): string {
  const params = new URLSearchParams();
  for (const key of ["relpath", "session_id", "target_session_id", "message_id", "target_message_id", "status"] as const) {
    const value = filter[key];
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `/v1/annotations?${query}` : "/v1/annotations";
}

export async function listAnnotations(
  http: AnnotationHttp,
  filter: AnnotationFilter & { target_session_id?: string } = {},
  signal?: AbortSignal,
): Promise<Annotation[]> {
  const page = await http.get<ListPage<Annotation> | { items: Annotation[] }>(annotationsPath(filter), signal);
  return page.items;
}

export function createAnnotation(http: AnnotationHttp, body: CreateAnnotationRequest): Promise<Annotation> {
  return http.post<Annotation>("/v1/annotations", body);
}

export function patchAnnotation(http: AnnotationHttp, id: string, patch: PatchAnnotationRequest & { if_revision?: string }): Promise<Annotation> {
  return http.patch<Annotation>(`/v1/annotations/${encodeURIComponent(id)}`, patch);
}

export function sendAnnotations(http: AnnotationHttp, body: SendAnnotationsRequest): Promise<SendAnnotationsResult> {
  return http.post<SendAnnotationsResult>("/v1/annotations/send", body);
}
