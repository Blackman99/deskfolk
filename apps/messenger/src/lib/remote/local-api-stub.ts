/** Hosted builds alias LocalApi here so loopback credentials never ship. */
export class LocalApi {
  constructor(_endpoint: { origin: string; token: string }) {
    throw new Error("local api is not compiled into the hosted messenger");
  }
}
