import { WEBAUTHN_ALGORITHMS, base64url, fromBase64url, type AssertionWire, type RegistrationWire } from "@real-bot/remote";
import { httpsOrigin } from "./origin.ts";

export type WebAuthnBridge = {
  create(options: CredentialCreationOptions): Promise<Credential | null>;
  get(options: CredentialRequestOptions): Promise<Credential | null>;
};

function defaultBridge(): WebAuthnBridge {
  return {
    create: (options) => navigator.credentials.create(options),
    get: (options) => navigator.credentials.get(options),
  };
}

function rpId(relayOrigin: string): string {
  return new URL(httpsOrigin(relayOrigin)).hostname;
}

function buffer(value: BufferSource): Uint8Array {
  const view = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(view);
}

function challengeBytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(fromBase64url(value)) as Uint8Array<ArrayBuffer>;
}

export async function createRegistration(
  challenge: string,
  relayOrigin: string,
  user: { id: string; name: string },
  bridge: WebAuthnBridge = defaultBridge(),
): Promise<RegistrationWire> {
  const credential = await bridge.create({
    publicKey: {
      challenge: challengeBytes(challenge),
      rp: { id: rpId(relayOrigin), name: "Real Bot" },
      user: { id: new TextEncoder().encode(user.id), name: user.name, displayName: user.name },
      pubKeyCredParams: WEBAUTHN_ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
      attestation: "none",
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      timeout: 60_000,
    },
  });
  if (!credential || credential.type !== "public-key" || !("response" in credential)) throw new Error("webauthn_failed");
  const response = (credential as PublicKeyCredential).response as AuthenticatorAttestationResponse;
  if (!response?.clientDataJSON || !response.attestationObject) throw new Error("webauthn_failed");
  return {
    credentialId: (credential as PublicKeyCredential).id,
    clientDataJSON: base64url(buffer(response.clientDataJSON)),
    attestationObject: base64url(buffer(response.attestationObject)),
  };
}

export async function createAssertion(
  challenge: string,
  relayOrigin: string,
  bridge: WebAuthnBridge = defaultBridge(),
): Promise<AssertionWire> {
  const credential = await bridge.get({
    publicKey: {
      challenge: challengeBytes(challenge),
      rpId: rpId(relayOrigin),
      userVerification: "required",
      timeout: 60_000,
    },
  });
  if (!credential || credential.type !== "public-key" || !("response" in credential)) throw new Error("webauthn_failed");
  const response = (credential as PublicKeyCredential).response as AuthenticatorAssertionResponse;
  if (!response?.clientDataJSON || !response.authenticatorData || !response.signature) throw new Error("webauthn_failed");
  return {
    credentialId: (credential as PublicKeyCredential).id,
    clientDataJSON: base64url(buffer(response.clientDataJSON)),
    authenticatorData: base64url(buffer(response.authenticatorData)),
    signature: base64url(buffer(response.signature)),
  };
}
