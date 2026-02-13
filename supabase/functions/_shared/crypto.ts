const NONCE_BYTES = 12;

type KeyRecord = {
  version: number;
  raw: Uint8Array;
  cryptoKey: CryptoKey;
};

export type EncryptResult = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: number;
};

function decodeBase64(value: string): Uint8Array {
  const normalized = value.trim();
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new Error("Encryption key must be valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 32) {
    throw new Error("Encryption key must decode to 32 bytes for AES-256-GCM.");
  }
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function createKeyringFromEnv(env: Record<string, string | undefined>) {
  const records: KeyRecord[] = [];
  const rawKeyset = env.TOKEN_ENCRYPTION_KEYS?.trim();

  if (rawKeyset) {
    const entries = rawKeyset
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const entry of entries) {
      const [rawVersion, rawKey] = entry.split(":", 2);
      const version = Number(rawVersion);
      if (!Number.isInteger(version) || version <= 0 || !rawKey) {
        throw new Error(
          "TOKEN_ENCRYPTION_KEYS must use 'version:base64Key' entries separated by commas.",
        );
      }
      const keyBytes = decodeBase64(rawKey);
      records.push({
        version,
        raw: keyBytes,
        cryptoKey: await importAesKey(keyBytes),
      });
    }
  } else {
    const legacyKey = env.TOKEN_ENCRYPTION_KEY?.trim();
    if (!legacyKey) {
      throw new Error(
        "Missing TOKEN_ENCRYPTION_KEY or TOKEN_ENCRYPTION_KEYS environment variable.",
      );
    }
    const keyVersion = Number(env.TOKEN_ENCRYPTION_KEY_VERSION ?? "1");
    if (!Number.isInteger(keyVersion) || keyVersion <= 0) {
      throw new Error("TOKEN_ENCRYPTION_KEY_VERSION must be a positive integer.");
    }

    const keyBytes = decodeBase64(legacyKey);
    records.push({
      version: keyVersion,
      raw: keyBytes,
      cryptoKey: await importAesKey(keyBytes),
    });
  }

  const uniqueVersions = new Set<number>();
  for (const record of records) {
    if (uniqueVersions.has(record.version)) {
      throw new Error(`Duplicate key version ${record.version} in encryption key config.`);
    }
    uniqueVersions.add(record.version);
  }

  records.sort((left, right) => left.version - right.version);
  const current = records[records.length - 1];

  return {
    currentVersion: current.version,
    versions: records.map((record) => record.version),
    async encrypt(plaintext: string): Promise<EncryptResult> {
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const encoded = new TextEncoder().encode(plaintext);
      const ciphertextBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        current.cryptoKey,
        encoded,
      );
      return {
        ciphertext: new Uint8Array(ciphertextBuffer),
        nonce,
        keyVersion: current.version,
      };
    },
    async decrypt(ciphertext: Uint8Array, nonce: Uint8Array, keyVersion: number) {
      const record = records.find((candidate) => candidate.version === keyVersion);
      if (!record) {
        throw new Error(`Unknown encryption key version: ${keyVersion}`);
      }
      const plaintextBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce },
        record.cryptoKey,
        ciphertext,
      );
      return new TextDecoder().decode(plaintextBuffer);
    },
  };
}

export function toPostgresBytea(value: Uint8Array): string {
  return `\\x${toHex(value)}`;
}

export function fromPostgresBytea(value: string): Uint8Array {
  const normalized = value.startsWith("\\x") ? value.slice(2) : value;
  if (normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
    throw new Error("Invalid bytea hex string.");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}
