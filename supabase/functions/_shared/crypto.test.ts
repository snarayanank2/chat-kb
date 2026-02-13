import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createKeyringFromEnv,
  fromPostgresBytea,
  toPostgresBytea,
} from "./crypto.ts";

Deno.test("encrypt/decrypt roundtrip with legacy key env", async () => {
  const key = btoa("12345678901234567890123456789012");
  const keyring = await createKeyringFromEnv({
    TOKEN_ENCRYPTION_KEY: key,
    TOKEN_ENCRYPTION_KEY_VERSION: "3",
  });

  const encrypted = await keyring.encrypt("refresh-token-value");
  const decrypted = await keyring.decrypt(
    encrypted.ciphertext,
    encrypted.nonce,
    encrypted.keyVersion,
  );

  assertEquals(encrypted.keyVersion, 3);
  assertEquals(decrypted, "refresh-token-value");
});

Deno.test("key rotation format writes newest and reads older versions", async () => {
  const keyV1 = btoa("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const keyV2 = btoa("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const keyring = await createKeyringFromEnv({
    TOKEN_ENCRYPTION_KEYS: `1:${keyV1},2:${keyV2}`,
  });

  assertEquals(keyring.currentVersion, 2);
  assertEquals(keyring.versions, [1, 2]);

  const oldMessage = "token-from-v1";
  const oldCipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: new Uint8Array(12) },
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      "AES-GCM",
      false,
      ["encrypt"],
    ),
    new TextEncoder().encode(oldMessage),
  );

  const decryptedOld = await keyring.decrypt(
    new Uint8Array(oldCipher),
    new Uint8Array(12),
    1,
  );
  assertEquals(decryptedOld, oldMessage);
});

Deno.test("decrypt fails for unknown key version", async () => {
  const key = btoa("12345678901234567890123456789012");
  const keyring = await createKeyringFromEnv({
    TOKEN_ENCRYPTION_KEY: key,
  });
  await assertRejects(
    () => keyring.decrypt(new Uint8Array([1, 2, 3]), new Uint8Array(12), 999),
    Error,
    "Unknown encryption key version",
  );
});

Deno.test("bytea conversion helpers are symmetric", () => {
  const input = new Uint8Array([0, 1, 15, 16, 255]);
  const encoded = toPostgresBytea(input);
  assertEquals(encoded, "\\x00010f10ff");
  assertEquals(fromPostgresBytea(encoded), input);
});

Deno.test("invalid key length throws", async () => {
  await assertRejects(
    () =>
      createKeyringFromEnv({
        TOKEN_ENCRYPTION_KEY: btoa("too-short"),
      }),
    Error,
    "32 bytes",
  );
});

Deno.test("invalid bytea hex throws", () => {
  assertThrows(() => fromPostgresBytea("\\x0g"));
});
