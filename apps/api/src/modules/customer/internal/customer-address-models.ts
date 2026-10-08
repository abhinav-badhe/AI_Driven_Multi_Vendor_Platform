export type AddressLabel = 'Home' | 'Work' | 'Other';

export interface CustomerAddressRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  label: AddressLabel;
  recipient_name: string;
  phone: string;
  address_line1: string;
  address_line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  google_place_id: string | null;
  formatted_address: string | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

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
  label?: AddressLabel | undefined;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string | null | undefined;
  landmark?: string | null | undefined;
  city: string;
  state: string;
  postalCode: string;
  country?: string | undefined;
  latitude?: number | null | undefined;
  longitude?: number | null | undefined;
  googlePlaceId?: string | null | undefined;
  formattedAddress?: string | null | undefined;
  isDefault?: boolean | undefined;
}

export interface UpdateAddressInput {
  label?: AddressLabel | undefined;
  recipientName?: string | undefined;
  phone?: string | undefined;
  addressLine1?: string | undefined;
  addressLine2?: string | null | undefined;
  landmark?: string | null | undefined;
  city?: string | undefined;
  state?: string | undefined;
  postalCode?: string | undefined;
  country?: string | undefined;
  latitude?: number | null | undefined;
  longitude?: number | null | undefined;
  googlePlaceId?: string | null | undefined;
  formattedAddress?: string | null | undefined;
  isDefault?: boolean | undefined;
}

export interface AddressSnapshot {
  id?: string | undefined;
  addressId?: string | undefined;
  label?: string | undefined;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string | null | undefined;
  landmark?: string | null | undefined;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude?: number | null | undefined;
  longitude?: number | null | undefined;
  googlePlaceId?: string | null | undefined;
  formattedAddress?: string | null | undefined;
  sourceType?: 'SAVED_ADDRESS' | 'MANUAL_ENTRY' | undefined;
}
