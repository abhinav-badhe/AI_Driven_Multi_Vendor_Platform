import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { CustomerAddressRow } from './customer-address-models.js';

export class CustomerAddressRepository {
  constructor(private readonly db: DatabaseConnection) {}

  async createAddress(
    row: {
      id: string;
      tenant_id: string;
      customer_id: string;
      label: string;
      recipient_name: string;
      phone: string;
      address_line1: string;
      address_line2?: string | null;
      landmark?: string | null;
      city: string;
      state: string;
      postal_code: string;
      country: string;
      latitude?: number | null;
      longitude?: number | null;
      google_place_id?: string | null;
      formatted_address?: string | null;
      is_default: boolean;
    },
    client?: DatabaseConnection,
  ): Promise<CustomerAddressRow> {
    const db = client ?? this.db;
    const query = `
      INSERT INTO customer_addresses (
        id, tenant_id, customer_id, label, recipient_name, phone,
        address_line1, address_line2, landmark, city, state, postal_code,
        country, latitude, longitude, google_place_id, formatted_address,
        is_default, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17,
        $18, NOW(), NOW()
      )
      RETURNING *
    `;
    const params = [
      row.id,
      row.tenant_id,
      row.customer_id,
      row.label,
      row.recipient_name,
      row.phone,
      row.address_line1,
      row.address_line2 ?? null,
      row.landmark ?? null,
      row.city,
      row.state,
      row.postal_code,
      row.country,
      row.latitude ?? null,
      row.longitude ?? null,
      row.google_place_id ?? null,
      row.formatted_address ?? null,
      row.is_default,
    ];
    const res = await db.query<CustomerAddressRow>(query, params);
    return res.rows[0]!;
  }

  async findAddressById(
    id: string,
    customerId?: string,
    client?: DatabaseConnection,
  ): Promise<CustomerAddressRow | null> {
    const db = client ?? this.db;
    let query = `SELECT * FROM customer_addresses WHERE id = $1`;
    const params: unknown[] = [id];
    if (customerId) {
      query += ` AND customer_id = $2`;
      params.push(customerId);
    }
    const res = await db.query<CustomerAddressRow>(query, params);
    return res.rows[0] ?? null;
  }

  async listAddressesByCustomer(
    customerId: string,
    client?: DatabaseConnection,
  ): Promise<CustomerAddressRow[]> {
    const db = client ?? this.db;
    const query = `
      SELECT * FROM customer_addresses
      WHERE customer_id = $1
      ORDER BY is_default DESC, created_at DESC
    `;
    const res = await db.query<CustomerAddressRow>(query, [customerId]);
    return res.rows;
  }

  async countAddressesByCustomer(customerId: string, client?: DatabaseConnection): Promise<number> {
    const db = client ?? this.db;
    const query = `SELECT COUNT(*)::int as count FROM customer_addresses WHERE customer_id = $1`;
    const res = await db.query<{ count: number }>(query, [customerId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async clearDefault(customerId: string, client?: DatabaseConnection): Promise<void> {
    const db = client ?? this.db;
    const query = `
      UPDATE customer_addresses
      SET is_default = false, updated_at = NOW()
      WHERE customer_id = $1 AND is_default = true
    `;
    await db.query(query, [customerId]);
  }

  async setDefault(
    id: string,
    customerId: string,
    client?: DatabaseConnection,
  ): Promise<CustomerAddressRow | null> {
    const db = client ?? this.db;
    const query = `
      UPDATE customer_addresses
      SET is_default = true, updated_at = NOW()
      WHERE id = $1 AND customer_id = $2
      RETURNING *
    `;
    const res = await db.query<CustomerAddressRow>(query, [id, customerId]);
    return res.rows[0] ?? null;
  }

  async updateAddress(
    id: string,
    customerId: string,
    updates: Partial<CustomerAddressRow>,
    client?: DatabaseConnection,
  ): Promise<CustomerAddressRow | null> {
    const db = client ?? this.db;
    const fields: string[] = [];
    const values: unknown[] = [id, customerId];
    let idx = 3;

    const allowedCols: Array<keyof CustomerAddressRow> = [
      'label',
      'recipient_name',
      'phone',
      'address_line1',
      'address_line2',
      'landmark',
      'city',
      'state',
      'postal_code',
      'country',
      'latitude',
      'longitude',
      'google_place_id',
      'formatted_address',
      'is_default',
    ];

    for (const col of allowedCols) {
      if (updates[col] !== undefined) {
        fields.push(`${col} = $${idx}`);
        values.push(updates[col]);
        idx++;
      }
    }

    if (fields.length === 0) {
      return this.findAddressById(id, customerId, client);
    }

    fields.push(`updated_at = NOW()`);

    const query = `
      UPDATE customer_addresses
      SET ${fields.join(', ')}
      WHERE id = $1 AND customer_id = $2
      RETURNING *
    `;
    const res = await db.query<CustomerAddressRow>(query, values);
    return res.rows[0] ?? null;
  }

  async deleteAddress(
    id: string,
    customerId: string,
    client?: DatabaseConnection,
  ): Promise<boolean> {
    const db = client ?? this.db;
    const query = `DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2`;
    const res = await db.query(query, [id, customerId]);
    return (res.rowCount ?? 0) > 0;
  }

  async findFirstAlternativeAddress(
    customerId: string,
    excludeId: string,
    client?: DatabaseConnection,
  ): Promise<CustomerAddressRow | null> {
    const db = client ?? this.db;
    const query = `
      SELECT * FROM customer_addresses
      WHERE customer_id = $1 AND id != $2
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `;
    const res = await db.query<CustomerAddressRow>(query, [customerId, excludeId]);
    return res.rows[0] ?? null;
  }
}
