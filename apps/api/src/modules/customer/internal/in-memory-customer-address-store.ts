import type { AuthorizedActor } from '../../identity/rbac/policy.js';
import type {
  CustomerAddressDto,
  AddressSnapshot,
  ICustomerAddressReader,
} from './customer-address-models.js';
import { NotFoundError } from '../../../errors/app-error.js';

/**
 * InMemoryCustomerAddressStore - Zero-Database Customer Address Store.
 *
 * Implements ICustomerAddressReader in memory for testing, isolated microservice
 * operations, and fallback delivery-address lookups when the customer database is offline.
 */
export class InMemoryCustomerAddressStore implements ICustomerAddressReader {
  private addresses = new Map<string, CustomerAddressDto>();

  setAddress(address: CustomerAddressDto): void {
    this.addresses.set(address.id, { ...address });
  }

  async getAddressById(actor: AuthorizedActor, id: string): Promise<CustomerAddressDto> {
    const address = this.addresses.get(id);
    if (!address) {
      throw new NotFoundError(`Address '${id}' not found`);
    }
    if (address.customerId !== actor.userId && actor.role !== 'ADMINISTRATOR') {
      throw new NotFoundError(`Address '${id}' not found`);
    }
    return address;
  }

  async getDefaultAddress(actor: AuthorizedActor): Promise<CustomerAddressDto | null> {
    for (const address of this.addresses.values()) {
      if (address.customerId === actor.userId && address.isDefault) {
        return address;
      }
    }
    return null;
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

  clear(): void {
    this.addresses.clear();
  }
}
