import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../../infra/database/connection.js';
import type { Logger } from '../../../observability/logger.js';
import type { AuthorizedActor } from '../../identity/index.js';
import { RbacPolicy } from '../../identity/index.js';
import {
  ValidationError,
  NotFoundError,
} from '../../../errors/app-error.js';
import { CustomerAddressRepository } from './customer-address-repository.js';
import type {
  AddressLabel,
  CreateAddressInput,
  CustomerAddressDto,
  CustomerAddressRow,
  UpdateAddressInput,
  AddressSnapshot,
} from './customer-address-models.js';

export class CustomerAddressService {
  private readonly repo: CustomerAddressRepository;

  constructor(
    private readonly db: DatabaseConnection,
    private readonly logger: Logger,
  ) {
    this.repo = new CustomerAddressRepository(db);
  }

  private validateLabel(label?: string): AddressLabel {
    if (!label) return 'Home';
    const allowed: AddressLabel[] = ['Home', 'Work', 'Other'];
    if (!allowed.includes(label as AddressLabel)) {
      throw new ValidationError(`Invalid label '${label}'. Allowed labels: ${allowed.join(', ')}`);
    }
    return label as AddressLabel;
  }

  private validateAddressInput(input: CreateAddressInput): void {
    if (!input.recipientName || typeof input.recipientName !== 'string' || !input.recipientName.trim()) {
      throw new ValidationError('recipientName is required');
    }
    if (!input.phone || typeof input.phone !== 'string' || !input.phone.trim()) {
      throw new ValidationError('phone is required');
    }
    if (!input.addressLine1 || typeof input.addressLine1 !== 'string' || !input.addressLine1.trim()) {
      throw new ValidationError('addressLine1 is required');
    }
    if (!input.city || typeof input.city !== 'string' || !input.city.trim()) {
      throw new ValidationError('city is required');
    }
    if (!input.state || typeof input.state !== 'string' || !input.state.trim()) {
      throw new ValidationError('state is required');
    }
    if (!input.postalCode || typeof input.postalCode !== 'string' || !input.postalCode.trim()) {
      throw new ValidationError('postalCode is required');
    }
    if (input.latitude !== undefined && input.latitude !== null && (typeof input.latitude !== 'number' || isNaN(input.latitude))) {
      throw new ValidationError('latitude must be a valid number');
    }
    if (input.longitude !== undefined && input.longitude !== null && (typeof input.longitude !== 'number' || isNaN(input.longitude))) {
      throw new ValidationError('longitude must be a valid number');
    }
  }

  private toDto(row: CustomerAddressRow): CustomerAddressDto {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      customerId: row.customer_id,
      label: row.label,
      recipientName: row.recipient_name,
      phone: row.phone,
      addressLine1: row.address_line1,
      addressLine2: row.address_line2,
      landmark: row.landmark,
      city: row.city,
      state: row.state,
      postalCode: row.postal_code,
      country: row.country,
      latitude: row.latitude !== null ? Number(row.latitude) : null,
      longitude: row.longitude !== null ? Number(row.longitude) : null,
      googlePlaceId: row.google_place_id,
      formattedAddress: row.formatted_address,
      isDefault: Boolean(row.is_default),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  async listAddresses(actor: AuthorizedActor): Promise<CustomerAddressDto[]> {
    RbacPolicy.requirePermission(actor, 'customer:address:read-own');
    const customerId = actor.userId;
    const rows = await this.repo.listAddressesByCustomer(customerId);
    return rows.map((r) => this.toDto(r));
  }

  async getAddress(actor: AuthorizedActor, id: string): Promise<CustomerAddressDto> {
    RbacPolicy.requirePermission(actor, 'customer:address:read-own');
    const customerId = actor.role === 'ADMINISTRATOR' ? undefined : actor.userId;
    const row = await this.repo.findAddressById(id, customerId);
    if (!row) {
      throw new NotFoundError(`Address '${id}' not found`);
    }
    return this.toDto(row);
  }

  async createAddress(actor: AuthorizedActor, input: CreateAddressInput): Promise<CustomerAddressDto> {
    RbacPolicy.requirePermission(actor, 'customer:address:manage-own');
    this.validateAddressInput(input);
    const label = this.validateLabel(input.label);
    const customerId = actor.userId;
    const tenantId = actor.tenantId;

    const result = await this.db.withTransaction(async (tx) => {
      const txRepo = new CustomerAddressRepository(tx);
      const existingCount = await txRepo.countAddressesByCustomer(customerId, tx);

      // Rule: First address automatically becomes default
      const isDefault = existingCount === 0 ? true : Boolean(input.isDefault);

      if (isDefault && existingCount > 0) {
        await txRepo.clearDefault(customerId, tx);
      }

      const id = randomUUID();
      const created = await txRepo.createAddress(
        {
          id,
          tenant_id: tenantId,
          customer_id: customerId,
          label,
          recipient_name: input.recipientName.trim(),
          phone: input.phone.trim(),
          address_line1: input.addressLine1.trim(),
          address_line2: input.addressLine2?.trim() || null,
          landmark: input.landmark?.trim() || null,
          city: input.city.trim(),
          state: input.state.trim(),
          postal_code: input.postalCode.trim(),
          country: input.country?.trim() || 'US',
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          google_place_id: input.googlePlaceId?.trim() || null,
          formatted_address: input.formattedAddress?.trim() || null,
          is_default: isDefault,
        },
        tx,
      );

      return created;
    });

    this.logger.info('Created customer address', {
      addressId: result.id,
      customerId,
      isDefault: result.is_default,
    });

    return this.toDto(result);
  }

  async updateAddress(actor: AuthorizedActor, id: string, input: UpdateAddressInput): Promise<CustomerAddressDto> {
    RbacPolicy.requirePermission(actor, 'customer:address:manage-own');
    const customerId = actor.userId;

    const result = await this.db.withTransaction(async (tx) => {
      const txRepo = new CustomerAddressRepository(tx);
      const existing = await txRepo.findAddressById(id, customerId, tx);
      if (!existing) {
        throw new NotFoundError(`Address '${id}' not found`);
      }

      const updates: Partial<CustomerAddressRow> = {};
      if (input.label !== undefined) {
        updates.label = this.validateLabel(input.label);
      }
      if (input.recipientName !== undefined) {
        if (!input.recipientName.trim()) throw new ValidationError('recipientName cannot be empty');
        updates.recipient_name = input.recipientName.trim();
      }
      if (input.phone !== undefined) {
        if (!input.phone.trim()) throw new ValidationError('phone cannot be empty');
        updates.phone = input.phone.trim();
      }
      if (input.addressLine1 !== undefined) {
        if (!input.addressLine1.trim()) throw new ValidationError('addressLine1 cannot be empty');
        updates.address_line1 = input.addressLine1.trim();
      }
      if (input.addressLine2 !== undefined) {
        updates.address_line2 = input.addressLine2 ? input.addressLine2.trim() : null;
      }
      if (input.landmark !== undefined) {
        updates.landmark = input.landmark ? input.landmark.trim() : null;
      }
      if (input.city !== undefined) {
        if (!input.city.trim()) throw new ValidationError('city cannot be empty');
        updates.city = input.city.trim();
      }
      if (input.state !== undefined) {
        if (!input.state.trim()) throw new ValidationError('state cannot be empty');
        updates.state = input.state.trim();
      }
      if (input.postalCode !== undefined) {
        if (!input.postalCode.trim()) throw new ValidationError('postalCode cannot be empty');
        updates.postal_code = input.postalCode.trim();
      }
      if (input.country !== undefined) {
        updates.country = input.country.trim() || 'US';
      }
      if (input.latitude !== undefined) {
        updates.latitude = input.latitude;
      }
      if (input.longitude !== undefined) {
        updates.longitude = input.longitude;
      }
      if (input.googlePlaceId !== undefined) {
        updates.google_place_id = input.googlePlaceId ? input.googlePlaceId.trim() : null;
      }
      if (input.formattedAddress !== undefined) {
        updates.formatted_address = input.formattedAddress ? input.formattedAddress.trim() : null;
      }

      if (input.isDefault !== undefined) {
        if (input.isDefault && !existing.is_default) {
          // Setting new default
          await txRepo.clearDefault(customerId, tx);
          updates.is_default = true;
        } else if (!input.isDefault && existing.is_default) {
          // Cannot unset default if it's the only address
          const alternative = await txRepo.findFirstAlternativeAddress(customerId, id, tx);
          if (alternative) {
            await txRepo.setDefault(alternative.id, customerId, tx);
            updates.is_default = false;
          } else {
            // Keep default if it's the only address
            updates.is_default = true;
          }
        }
      }

      const updated = await txRepo.updateAddress(id, customerId, updates, tx);
      if (!updated) {
        throw new NotFoundError(`Address '${id}' not found`);
      }
      return updated;
    });

    return this.toDto(result);
  }

  async setDefaultAddress(actor: AuthorizedActor, id: string): Promise<CustomerAddressDto> {
    RbacPolicy.requirePermission(actor, 'customer:address:manage-own');
    const customerId = actor.userId;

    const result = await this.db.withTransaction(async (tx) => {
      const txRepo = new CustomerAddressRepository(tx);
      const existing = await txRepo.findAddressById(id, customerId, tx);
      if (!existing) {
        throw new NotFoundError(`Address '${id}' not found`);
      }

      await txRepo.clearDefault(customerId, tx);
      const updated = await txRepo.setDefault(id, customerId, tx);
      if (!updated) {
        throw new NotFoundError(`Address '${id}' not found`);
      }
      return updated;
    });

    this.logger.info('Set default customer address', { addressId: id, customerId });
    return this.toDto(result);
  }

  async deleteAddress(actor: AuthorizedActor, id: string): Promise<void> {
    RbacPolicy.requirePermission(actor, 'customer:address:manage-own');
    const customerId = actor.userId;

    await this.db.withTransaction(async (tx) => {
      const txRepo = new CustomerAddressRepository(tx);
      const existing = await txRepo.findAddressById(id, customerId, tx);
      if (!existing) {
        throw new NotFoundError(`Address '${id}' not found`);
      }

      await txRepo.deleteAddress(id, customerId, tx);

      // Rule: Deleting default safely promotes another address if available
      if (existing.is_default) {
        const alternative = await txRepo.findFirstAlternativeAddress(customerId, id, tx);
        if (alternative) {
          await txRepo.setDefault(alternative.id, customerId, tx);
        }
      }
    });

    this.logger.info('Deleted customer address', { addressId: id, customerId });
  }

  async getDefaultAddress(actor: AuthorizedActor): Promise<CustomerAddressDto | null> {
    RbacPolicy.requirePermission(actor, 'customer:address:read-own');
    const customerId = actor.userId;
    const addresses = await this.repo.listAddressesByCustomer(customerId);
    const def = addresses.find((a) => a.is_default);
    return def ? this.toDto(def) : null;
  }

  async getAddressById(actor: AuthorizedActor, id: string): Promise<CustomerAddressDto> {
    return this.getAddress(actor, id);
  }

  toSnapshot(address: CustomerAddressDto): AddressSnapshot {
    return {
      id: address.id,
      addressId: address.id,
      label: address.label,
      recipientName: address.recipientName,
      phone: address.phone,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2,
      landmark: address.landmark,
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      country: address.country,
      latitude: address.latitude,
      longitude: address.longitude,
      googlePlaceId: address.googlePlaceId,
      formattedAddress: address.formattedAddress,
      sourceType: 'SAVED_ADDRESS',
    };
  }
}
