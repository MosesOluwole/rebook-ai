import { and, asc, eq } from 'drizzle-orm';

import { parseNewLocation, type NewLocation } from '../../domain/location';
import { locations } from '../schema';
import { type TenantTx } from '../tenant-tx';

export interface Location {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly timeZone: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type { NewLocation };

export const locationsRepository = {
  /** Validates at the module boundary so a bad time zone is a ValidationError, not a CHECK failure. */
  async insert(tx: TenantTx, input: NewLocation): Promise<Location> {
    const location = parseNewLocation(input);
    const [row] = await tx.db
      .insert(locations)
      .values({ tenantId: tx.ctx.tenantId, name: location.name, timeZone: location.timeZone })
      .returning();
    if (row === undefined) {
      throw new Error('locations insert returned no row');
    }
    return row;
  },

  async findById(tx: TenantTx, id: string): Promise<Location | null> {
    const [row] = await tx.db
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, tx.ctx.tenantId), eq(locations.id, id)));
    return row ?? null;
  },

  list(tx: TenantTx): Promise<Location[]> {
    return tx.db
      .select()
      .from(locations)
      .where(eq(locations.tenantId, tx.ctx.tenantId))
      .orderBy(asc(locations.createdAt), asc(locations.id));
  },
};
