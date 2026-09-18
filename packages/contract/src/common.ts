import { z } from 'zod';

/** ULID or any opaque string id. */
export const Id = z.string().min(1);

/** ISO 8601 UTC timestamp. */
export const IsoDate = z.iso.datetime({ offset: true });
