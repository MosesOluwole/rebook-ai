import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import { type TenantTx } from '@/modules/tenancy';

import {
  type CustomFieldDefinition,
  type CustomFieldDefinitionInput,
  type CustomFieldEntity,
  type CustomFieldValue,
} from '../domain/custom-field';
import { customFieldDefinitions, customFieldValues } from './schema';

type DefinitionRow = typeof customFieldDefinitions.$inferSelect;

function toDefinition(row: DefinitionRow): CustomFieldDefinition {
  return {
    id: row.id,
    entity: row.entity,
    key: row.key,
    label: row.label,
    fieldType: row.fieldType,
    options: row.options,
    required: row.required,
    healthFreeTextOverride: row.healthFreeTextOverride,
  };
}

export const definitionsRepository = {
  async insert(tx: TenantTx, input: CustomFieldDefinitionInput): Promise<CustomFieldDefinition> {
    const [row] = await tx.db
      .insert(customFieldDefinitions)
      .values({ tenantId: tx.ctx.tenantId, ...input })
      .returning();
    if (row === undefined) {
      throw new Error('custom_field_definitions insert returned no row');
    }
    return toDefinition(row);
  },

  async delete(tx: TenantTx, id: string): Promise<CustomFieldDefinition | null> {
    const [row] = await tx.db
      .delete(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.tenantId, tx.ctx.tenantId),
          eq(customFieldDefinitions.id, id),
        ),
      )
      .returning();
    return row === undefined ? null : toDefinition(row);
  },

  async list(tx: TenantTx, entity?: CustomFieldEntity): Promise<CustomFieldDefinition[]> {
    const rows = await tx.db
      .select()
      .from(customFieldDefinitions)
      .where(
        entity === undefined
          ? eq(customFieldDefinitions.tenantId, tx.ctx.tenantId)
          : and(
              eq(customFieldDefinitions.tenantId, tx.ctx.tenantId),
              eq(customFieldDefinitions.entity, entity),
            ),
      )
      .orderBy(
        asc(customFieldDefinitions.entity),
        asc(customFieldDefinitions.createdAt),
        asc(customFieldDefinitions.id),
      );
    return rows.map(toDefinition);
  },
};

/**
 * Whether any definition exists that a health business may not hold: a client-scoped field, or a
 * free-text field without the override (the same rule as the trigger on tenants).
 */
export async function anyBarredForHealth(tx: TenantTx): Promise<boolean> {
  const rows = await tx.db
    .select({ id: customFieldDefinitions.id })
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.tenantId, tx.ctx.tenantId),
        or(
          eq(customFieldDefinitions.entity, 'client'),
          and(
            inArray(customFieldDefinitions.fieldType, ['text', 'long_text']),
            eq(customFieldDefinitions.healthFreeTextOverride, false),
          ),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export const valuesRepository = {
  async upsertForService(
    tx: TenantTx,
    serviceId: string,
    definitionId: string,
    value: CustomFieldValue,
  ): Promise<void> {
    await tx.db
      .insert(customFieldValues)
      .values({ tenantId: tx.ctx.tenantId, definitionId, entity: 'service', serviceId, value })
      .onConflictDoUpdate({
        target: [
          customFieldValues.tenantId,
          customFieldValues.definitionId,
          customFieldValues.serviceId,
        ],
        set: { value, updatedAt: sql`now()` },
      });
  },

  async deleteForService(tx: TenantTx, serviceId: string, definitionId: string): Promise<void> {
    await tx.db
      .delete(customFieldValues)
      .where(
        and(
          eq(customFieldValues.tenantId, tx.ctx.tenantId),
          eq(customFieldValues.serviceId, serviceId),
          eq(customFieldValues.definitionId, definitionId),
        ),
      );
  },

  async listForService(
    tx: TenantTx,
    serviceId: string,
  ): Promise<{ definitionId: string; value: unknown }[]> {
    return tx.db
      .select({ definitionId: customFieldValues.definitionId, value: customFieldValues.value })
      .from(customFieldValues)
      .where(
        and(
          eq(customFieldValues.tenantId, tx.ctx.tenantId),
          eq(customFieldValues.serviceId, serviceId),
        ),
      );
  },
};
