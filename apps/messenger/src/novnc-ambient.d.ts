/**
 * noVNC ships plain JavaScript with no types. The remote screen page drives it through its own
 * narrow interface (`Rfb` in RemoteScreenView.svelte), so the module itself is only an opaque class.
 */
declare module '@novnc/novnc' {
  const RFB: unknown;
  export default RFB;
}
