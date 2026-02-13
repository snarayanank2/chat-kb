const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{2,62}$/;

export function normalizeHandle(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function validateHandle(value: string): string | null {
  if (!HANDLE_REGEX.test(value)) {
    return "Handle must be 3-63 chars, lowercase letters/numbers/hyphens, and start with a letter or number.";
  }
  return null;
}

export function parseOrigins(input: string): string[] {
  return input
    .split(/[\n,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function validateOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Invalid URL format.";
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "Only http:// or https:// origins are allowed.";
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return "Origin must be exact and include only scheme + host (+ optional port).";
  }
  if (url.origin !== value) {
    return "Origin must exactly match URL origin format (e.g. https://example.com).";
  }
  return null;
}

export function validateOrigins(origins: string[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const origin of origins) {
    const err = validateOrigin(origin);
    if (err) {
      errors.push(`${origin}: ${err}`);
      continue;
    }
    if (seen.has(origin)) {
      errors.push(`${origin}: duplicate origin`);
      continue;
    }
    seen.add(origin);
  }

  return errors;
}
