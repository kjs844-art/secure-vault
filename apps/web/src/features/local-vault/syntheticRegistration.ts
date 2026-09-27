import { CatalogAdapterError } from "../../bridge/catalogProtocol";

/** Closed demo IDs only. These are not service IDs, credentials, or an import DTO. */
export type SyntheticRegistrationSelection = {
  readonly profileId: 0 | 1;
  readonly credentialId: 0;
  readonly connectionIds: readonly (0 | 1 | 2)[];
} | {
  readonly profileId: 2;
  readonly credentialId: 1 | 2;
  readonly connectionIds: readonly [];
};

/** Copy exact data fields before any await; never read getters or accept extra input. */
export function parseSyntheticRegistration(value: unknown): SyntheticRegistrationSelection {
  try {
    if (value === null || typeof value !== "object") throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(fields).length !== 3) throw new Error();
    const read = (key: string): unknown => {
      const descriptor = fields[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      return descriptor.value;
    };
    const profileId = read("profileId");
    const credentialId = read("credentialId");
    const input = read("connectionIds");
    const apiKey = (profileId === 0 || profileId === 1) && credentialId === 0;
    const password = profileId === 2 && (credentialId === 1 || credentialId === 2);
    if (!apiKey && !password) throw new Error();
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw new Error();
    const length: unknown = Object.getOwnPropertyDescriptor(input, "length")?.value;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > 3) throw new Error();
    // Password examples have no API connection capability. Do not silently
    // discard supplied connections or enumerate a forbidden selection.
    if (password && length !== 0) throw new Error();
    const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(input) as Record<string, PropertyDescriptor>;
    if (Reflect.ownKeys(descriptors).length !== length + 1) throw new Error();
    const connectionIds: (0 | 1 | 2)[] = [];
    for (let index = 0; index < length; index += 1) {
      const field = descriptors[String(index)];
      if (!field || !("value" in field) || !field.enumerable) throw new Error();
      const id: unknown = field.value;
      if ((id !== 0 && id !== 1 && id !== 2) || connectionIds.includes(id)) throw new Error();
      connectionIds.push(id);
    }
    if (password) {
      return Object.freeze({ profileId, credentialId, connectionIds: Object.freeze([] as const) });
    }
    if (apiKey) return Object.freeze({ profileId, credentialId, connectionIds: Object.freeze(connectionIds) });
    throw new Error();
  } catch {
    throw new CatalogAdapterError("INVALID_ARCHIVE");
  }
}
