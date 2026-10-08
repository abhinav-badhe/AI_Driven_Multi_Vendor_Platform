import { apiClient } from '../../../api/client';

export type AddressLabel = 'Home' | 'Work' | 'Other';

export interface CustomerAddressDto {
  id: string;
  tenantId: string;
  customerId: string;
  label: AddressLabel;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string | null;
  landmark?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude?: number | null;
  longitude?: number | null;
  googlePlaceId?: string | null;
  formattedAddress?: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAddressInput {
  label?: AddressLabel;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string | null;
  landmark?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  googlePlaceId?: string | null;
  formattedAddress?: string | null;
  isDefault?: boolean;
}

export interface UpdateAddressInput {
  label?: AddressLabel;
  recipientName?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string | null;
  landmark?: string | null;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  googlePlaceId?: string | null;
  formattedAddress?: string | null;
  isDefault?: boolean;
}

export const addressesApi = {
  listAddresses: async (): Promise<CustomerAddressDto[]> => {
    return apiClient<CustomerAddressDto[]>('/customer/addresses');
  },

  getAddress: async (id: string): Promise<CustomerAddressDto> => {
    return apiClient<CustomerAddressDto>(`/customer/addresses/${id}`);
  },

  createAddress: async (data: CreateAddressInput): Promise<CustomerAddressDto> => {
    return apiClient<CustomerAddressDto>('/customer/addresses', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  updateAddress: async (id: string, data: UpdateAddressInput): Promise<CustomerAddressDto> => {
    return apiClient<CustomerAddressDto>(`/customer/addresses/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  deleteAddress: async (id: string): Promise<void> => {
    await apiClient(`/customer/addresses/${id}`, {
      method: 'DELETE',
    });
  },

  setDefaultAddress: async (id: string): Promise<CustomerAddressDto> => {
    return apiClient<CustomerAddressDto>(`/customer/addresses/${id}/default`, {
      method: 'POST',
    });
  },
};
