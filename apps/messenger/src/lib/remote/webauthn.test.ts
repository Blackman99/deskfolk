import { expect, test } from "bun:test";
import { createAssertion, createRegistration } from "./webauthn.ts";

test("WebAuthn create/get require UV and a domain rpId", async () => {
  let created: CredentialCreationOptions | undefined;
  let got: CredentialRequestOptions | undefined;
  const id = crypto.getRandomValues(new Uint8Array(16));
  const client = new Uint8Array([1, 2, 3]);
  const attestation = new Uint8Array([4, 5, 6]);
  const authenticator = new Uint8Array([7, 8, 9]);
  const signature = new Uint8Array([10, 11]);
  class Attestation extends EventTarget {
    clientDataJSON = client.buffer;
    attestationObject = attestation.buffer;
  }
  class Assertion extends EventTarget {
    clientDataJSON = client.buffer;
    authenticatorData = authenticator.buffer;
    signature = signature.buffer;
  }
  const createCred = { id: "cred", type: "public-key", rawId: id, response: new Attestation() } as unknown as Credential;
  const getCred = { id: "cred", type: "public-key", rawId: id, response: new Assertion() } as unknown as Credential;
  const bridge = {
    async create(options: CredentialCreationOptions) {
      created = options;
      return createCred;
    },
    async get(options: CredentialRequestOptions) {
      got = options;
      return getCred;
    },
  };
  await createRegistration("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "https://relay.example.test", { id: "device", name: "phone" }, bridge);
  expect(created?.publicKey?.rp.id).toBe("relay.example.test");
  expect(created?.publicKey?.authenticatorSelection?.userVerification).toBe("required");
  expect(created?.publicKey?.attestation).toBe("none");
  await createAssertion("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "https://relay.example.test", bridge);
  expect(got?.publicKey?.rpId).toBe("relay.example.test");
  expect(got?.publicKey?.userVerification).toBe("required");
});
