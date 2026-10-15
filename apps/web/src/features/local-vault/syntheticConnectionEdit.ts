import { CatalogAdapterError } from "../../bridge/catalogProtocol";

/** Ephemeral catalog position and closed public fixture IDs, never persisted IDs or text. */
export interface SyntheticConnectionEditSelection {
  readonly reference: number;
  readonly connectionIds: readonly (0 | 1 | 2)[];
}

/** Reject accessors, inherited/extra fields, holes, duplicates and unbounded inputs. */
export function parseSyntheticConnectionEdit(value: unknown): SyntheticConnectionEditSelection {
  try {
    if (value === null || typeof value !== "object") throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(fields).length !== 2) throw new Error();
    const read = (key: string): unknown => {
      const descriptor = fields[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error();
      return descriptor.value;
    };
    const reference = read("reference");
    const input = read("connectionIds");
    if (typeof reference !== "number" || !Number.isSafeInteger(reference) || reference < 0 || reference > 127) throw new Error();
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) throw new Error();
    const length: unknown = Object.getOwnPropertyDescriptor(input, "length")?.value;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > 3) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input) as Record<string, PropertyDescriptor>;
    if (Reflect.ownKeys(descriptors).length !== length + 1) throw new Error();
    const connectionIds: (0 | 1 | 2)[] = [];
    for (let index = 0; index < length; index += 1) {
      const field = descriptors[String(index)];
      if (!field || !("value" in field) || !field.enumerable) throw new Error();
      const id: unknown = field.value;
      if ((id !== 0 && id !== 1 && id !== 2) || connectionIds.includes(id)) throw new Error();
      connectionIds.push(id);
    }
    return Object.freeze({ reference, connectionIds: Object.freeze(connectionIds) });
  } catch {
    throw new CatalogAdapterError("INVALID_ARCHIVE");
  }
}
