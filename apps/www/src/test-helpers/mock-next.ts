import { vi } from "vitest";
import { Session } from "@terragon/shared";
import { NextRequest } from "next/server";

interface MockHeadersOptions {
  headers?: Record<string, string>;
}

function createMockHeaders(options: MockHeadersOptions = {}) {
  const headerMap = new Map(Object.entries(options.headers || {}));

  return {
    get: vi.fn((name: string) => headerMap.get(name) || null),
    has: vi.fn((name: string) => headerMap.has(name)),
    entries: vi.fn(() => Array.from(headerMap.entries())),
    keys: vi.fn(() => Array.from(headerMap.keys())),
    values: vi.fn(() => Array.from(headerMap.values())),
    forEach: vi.fn((callback: (value: string, key: string) => void) => {
      headerMap.forEach((value, key) => callback(value, key));
    }),
    append: vi.fn((name: string, value: string) => {
      const existing = headerMap.get(name);
      if (existing) {
        headerMap.set(name, `${existing}, ${value}`);
      } else {
        headerMap.set(name, value);
      }
    }),
    set: vi.fn((name: string, value: string) => {
      headerMap.set(name, value);
    }),
    delete: vi.fn((name: string) => {
      headerMap.delete(name);
    }),
    getSetCookie: vi.fn(() => {
      const setCookie = headerMap.get("set-cookie");
      return setCookie ? [setCookie] : [];
    }),
    [Symbol.iterator]: vi.fn(function* () {
      yield* headerMap.entries();
    }),
  };
}

export async function createMockNextRequest(
  body: any,
  customHeaders: Record<string, string> = {},
): Promise<NextRequest> {
  const payload = JSON.stringify(body);
  await mockNextHeaders(customHeaders);
  return {
    text: vi.fn().mockResolvedValue(payload),
    headers: createMockHeaders({ headers: customHeaders }),
  } as unknown as NextRequest;
}

export async function mockNextHeaders(mockHeaders: Record<string, string>) {
  const { headers } = await import("next/headers");
  (headers as any).mockImplementation(async () => {
    return createMockHeaders({ headers: mockHeaders });
  });
}

export async function mockLoggedOutUser() {
  const { headers } = await import("next/headers");
  (headers as any).mockImplementation(async () => {
    return createMockHeaders();
  });
}

export async function mockLoggedInUser(session: Session) {
  const { headers } = await import("next/headers");
  (headers as any).mockImplementation(async () => {
    return createMockHeaders({
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });
  });
}

const promises: Promise<any>[] = [];

export async function mockWaitUntil() {
  const { waitUntil } = await import("@vercel/functions");
  (waitUntil as any).mockImplementation((promise: Promise<any>) => {
    promises.push(promise);
  });
}

export async function waitUntilResolved() {
  console.log("waitUntilResolved", promises.length);
  while (promises.length > 0) {
    // Remove the batch from the shared array *before* awaiting. If a captured
    // promise rejects, awaiting first and splicing after would skip the splice
    // and leave the settled promise in `promises`, leaking it into the next
    // test — a rejection there surfaces as an unhandled rejection and fails an
    // unrelated test. Draining first keeps each test's waitUntil work isolated.
    const promisesToResolve = promises.splice(0, promises.length);
    await Promise.all(promisesToResolve);
  }
}
